const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname)); 

// Conexión segura a la base de datos
const sql = neon(process.env.DATABASE_URL);

app.post('/api', async (req, res) => {
    let { action, room, player, target, gameMode, content, replyTo } = req.body;
    
    // Normalizamos mayúsculas para evitar errores tontos
    if(room) room = room.trim().toUpperCase();
    if(player) player = player.trim().toUpperCase();

    try {
        // --- LISTAR SALAS ---
        if (action === 'list') {
            const rooms = await sql`SELECT room_code, COUNT(*) as count, MAX(created_at) as created_at FROM rooms GROUP BY room_code ORDER BY created_at DESC LIMIT 10`;
            return res.json(rooms);
        }

        // --- UNIRSE A SALA ---
        if (action === 'join') {
            const existing = await sql`SELECT * FROM rooms WHERE room_code = ${room}`;
            
            // Limpieza de salas viejas (más de 30 min)
            let isStale = false;
            if (existing.length > 0) {
                const diffMinutes = (new Date() - new Date(existing[0].created_at)) / 1000 / 60;
                if (diffMinutes > 30) isStale = true;
            }

            if (existing.length === 0 || isStale) {
                // Crear sala nueva desde cero
                const randomSeed = Math.random().toString(36).substring(7);
                // Borramos todo lo viejo por si acaso
                await sql`DELETE FROM room_status WHERE room_code = ${room}`;
                await sql`DELETE FROM votes WHERE room_code = ${room}`;
                await sql`DELETE FROM rooms WHERE room_code = ${room}`;
                await sql`DELETE FROM messages WHERE room_code = ${room}`; 
                
                // Creamos los registros base
                await sql`INSERT INTO room_status (room_code, started, game_seed, ejected_player) VALUES (${room}, FALSE, ${randomSeed}, NULL)`;
                await sql`INSERT INTO rooms (room_code, player_name, is_leader) VALUES (${room}, ${player}, TRUE)`;
                console.log(`[SALA CREADA] ${room} por ${player}`);
            } else {
                const nameExists = existing.some(p => p.player_name === player);
                if (!nameExists) {
                    await sql`INSERT INTO rooms (room_code, player_name, is_leader) VALUES (${room}, ${player}, FALSE)`;
                }
            }
            return res.json({ msg: "Ok" });
        }

        // --- OBTENER ESTADO (LOBBY) ---
        if (action === 'get') {
            const players = await sql`SELECT player_name, is_leader FROM rooms WHERE room_code = ${room}`;
            if (players.length === 0) return res.json({ restart: true });

            const amIHere = players.some(p => p.player_name === player);
            if (!amIHere) return res.json({ restart: true });

            const status = await sql`SELECT started, game_seed, ejected_player FROM room_status WHERE room_code = ${room}`;
            
            // Si por algún error raro no hay status, lo creamos al vuelo
            let gameStarted = false;
            let gameSeed = "default";
            let ejected = null;

            if (status.length > 0) {
                gameStarted = status[0].started;
                gameSeed = status[0].game_seed;
                ejected = status[0].ejected_player;
            }

            const myVote = await sql`SELECT target FROM votes WHERE room_code = ${room} AND voter = ${player}`;
            const votesRaw = await sql`SELECT target, COUNT(*) as c FROM votes WHERE room_code = ${room} GROUP BY target`;
            
            const voteCounts = {};
            votesRaw.forEach(r => voteCounts[r.target] = parseInt(r.c));
            const leaderObj = players.find(p => p.is_leader);

            return res.json({ 
                players: players.map(p => p.player_name),
                leader: leaderObj ? leaderObj.player_name : "",
                started: gameStarted,
                seed: gameSeed,
                ejected: ejected,
                hasVoted: myVote.length > 0,
                votes: voteCounts
            });
        }

        // --- CHAT ---
        if (action === 'send_message') {
            if (content && content.trim().length > 0) {
                await sql`INSERT INTO messages (room_code, player_name, content, reply_to) VALUES (${room}, ${player}, ${content}, ${replyTo || null})`;
                return res.json({ msg: "Sent" });
            }
            return res.json({ msg: "Empty" });
        }

        if (action === 'get_messages') {
            const msgs = await sql`SELECT id, player_name, content, reply_to FROM messages WHERE room_code = ${room} ORDER BY id ASC LIMIT 50`;
            return res.json(msgs);
        }

        // --- INICIAR PARTIDA (AQUÍ FALLABA) ---
        if (action === 'start') {
            console.log(`[START] Intentando iniciar ${room} solicitado por ${player}`);
            const check = await sql`SELECT is_leader FROM rooms WHERE room_code = ${room} AND player_name = ${player}`;
            
            if (check.length > 0 && check[0].is_leader) {
                let finalSeed = Math.random().toString(36).substring(7) + "|NONE|" + (gameMode || "CLASSIC");
                if (gameMode === "AKUMA" && Math.random() < 0.15) finalSeed += "|EVENT_ROOM"; 
                else finalSeed += "|NO_EVENT";

                // Aseguramos que existe el status antes de actualizar
                const statusCheck = await sql`SELECT * FROM room_status WHERE room_code = ${room}`;
                if (statusCheck.length === 0) {
                    await sql`INSERT INTO room_status (room_code, started, game_seed, ejected_player) VALUES (${room}, TRUE, ${finalSeed}, NULL)`;
                } else {
                    await sql`UPDATE room_status SET started = TRUE, game_seed = ${finalSeed} WHERE room_code = ${room}`;
                }
                
                console.log(`[START] ¡Éxito! Sala ${room} iniciada.`);
                return res.json({ msg: "Started" });
            } else {
                console.log(`[START] Fallo: ${player} no es líder de ${room}`);
                return res.status(403).json({ error: "No eres el líder" });
            }
        }

        // --- VOTAR ---
        if (action === 'vote') {
            await sql`INSERT INTO votes (room_code, voter, target) VALUES (${room}, ${player}, ${target}) ON CONFLICT (room_code, voter) DO UPDATE SET target = ${target}`;
            const totalPlayers = await sql`SELECT COUNT(*) FROM rooms WHERE room_code = ${room}`;
            const totalVotes = await sql`SELECT COUNT(*) FROM votes WHERE room_code = ${room}`;
            
            if (parseInt(totalVotes[0].count) >= parseInt(totalPlayers[0].count)) {
                const results = await sql`SELECT target, COUNT(*) as count FROM votes WHERE room_code = ${room} GROUP BY target ORDER BY count DESC`;
                let ejected = results.length > 0 ? results[0].target : 'SKIP';
                await sql`UPDATE room_status SET ejected_player = ${ejected} WHERE room_code = ${room}`;
            }
            return res.json({ msg: "Voted" });
        }

        // --- REINICIAR ---
        if (action === 'reset') {
            const check = await sql`SELECT is_leader FROM rooms WHERE room_code = ${room} AND player_name = ${player}`;
            if (check.length > 0 && check[0].is_leader) {
                await sql`DELETE FROM votes WHERE room_code = ${room}`;
                await sql`UPDATE room_status SET started = FALSE, ejected_player = NULL WHERE room_code = ${room}`;
                return res.json({ msg: "Reset" });
            }
            return res.json({ msg: "Not Leader" });
        }
        
        // --- ADMIN / KICK ---
        if (action === 'kick' || action === 'clean') {
             const check = await sql`SELECT is_leader FROM rooms WHERE room_code = ${room} AND player_name = ${player}`;
             const isAdmin = player === 'STRIOLO'; 
             
             if ((check.length > 0 && check[0].is_leader) || isAdmin) {
                 if(action === 'kick') {
                     await sql`DELETE FROM rooms WHERE room_code = ${room} AND player_name = ${target}`;
                     await sql`DELETE FROM votes WHERE room_code = ${room} AND voter = ${target}`;
                 } else {
                     await sql`DELETE FROM rooms WHERE room_code = ${room}`;
                     await sql`DELETE FROM votes WHERE room_code = ${room}`;
                     await sql`DELETE FROM room_status WHERE room_code = ${room}`;
                     await sql`DELETE FROM messages WHERE room_code = ${room}`;
                 }
                 return res.json({ msg: "Ok" });
             }
             return res.status(403).json({ error: "Sin permisos" });
        }

        return res.status(400).json({ error: "Acción desconocida" });

    } catch (error) { 
        console.error("Error SERVER:", error);
        res.status(500).send(String(error)); 
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor Nakama LISTO en puerto ${PORT}`));
