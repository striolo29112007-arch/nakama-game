const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname)); 

const sql = neon(process.env.DATABASE_URL);

app.post('/api', async (req, res) => {
    let { action, room, player, target } = req.body;
    
    // Limpieza básica de inputs
    if(room) room = room.trim().toUpperCase();
    if(player) player = player.trim().toUpperCase();

    try {
        // --- LISTAR SALAS ---
        if (action === 'list') {
            const rooms = await sql`SELECT room_code, COUNT(*) as count, MAX(created_at) as created_at FROM rooms GROUP BY room_code ORDER BY created_at DESC LIMIT 10`;
            return res.json(rooms);
        }

        // --- UNIRSE (¡AHORA CON RECONEXIÓN!) ---
        if (action === 'join') {
            const existing = await sql`SELECT * FROM rooms WHERE room_code = ${room}`;
            
            // Comprobar si la sala está caducada (más de 30 min)
            let isStale = false;
            if (existing.length > 0) {
                const diffMinutes = (new Date() - new Date(existing[0].created_at)) / 1000 / 60;
                if (diffMinutes > 30) isStale = true;
            }

            // Si no existe o está vieja, crear nueva
            if (existing.length === 0 || isStale) {
                const randomSeed = Math.random().toString(36).substring(7);
                // Limpiamos por si acaso
                await sql`DELETE FROM room_status WHERE room_code = ${room}`;
                await sql`DELETE FROM votes WHERE room_code = ${room}`;
                await sql`DELETE FROM rooms WHERE room_code = ${room}`;
                
                await sql`INSERT INTO room_status (room_code, started, game_seed, ejected_player) VALUES (${room}, FALSE, ${randomSeed}, NULL)`;
                await sql`INSERT INTO rooms (room_code, player_name, is_leader) VALUES (${room}, ${player}, TRUE)`;
            } else {
                // Si la sala existe, miramos si el nombre ya está
                const nameExists = existing.some(p => p.player_name === player);
                
                if (nameExists) {
                    // ¡AQUÍ ESTÁ EL CAMBIO! 
                    // Si ya existes, te dejamos pasar (Reconexión) en lugar de dar error.
                    return res.json({ msg: "Reconnected" }); 
                }
                
                // Si es un jugador nuevo, lo añadimos
                await sql`INSERT INTO rooms (room_code, player_name, is_leader) VALUES (${room}, ${player}, FALSE)`;
            }
            return res.json({ msg: "Ok" });
        }

        // --- LIMPIAR (SOLO LÍDER O ADMIN STRIOLO) ---
        if (action === 'clean') {
            const check = await sql`SELECT is_leader FROM rooms WHERE room_code = ${room} AND player_name = ${player}`;
            const isLeader = check.length > 0 && check[0].is_leader;
            const isAdmin = player === 'STRIOLO'; 

            if (isLeader || isAdmin) {
                await sql`DELETE FROM rooms WHERE room_code = ${room} AND player_name != ${player}`; // Echamos a todos menos al que limpia
                if(isAdmin) await sql`DELETE FROM rooms WHERE room_code = ${room}`; // Si es Striolo, borra hasta al líder (reset total)
                
                await sql`DELETE FROM votes WHERE room_code = ${room}`;
                await sql`UPDATE room_status SET started = FALSE, ejected_player = NULL WHERE room_code = ${room}`;
                return res.json({ msg: "Cleaned" });
            }
        }

        // --- LEER ESTADO ---
        if (action === 'get') {
            const players = await sql`SELECT player_name, is_leader FROM rooms WHERE room_code = ${room}`;
            if (players.length === 0) return res.json({ restart: true });

            const amIHere = players.some(p => p.player_name === player);
            if (!amIHere) return res.json({ restart: true });

            const status = await sql`SELECT started, game_seed, ejected_player FROM room_status WHERE room_code = ${room}`;
            const myVote = await sql`SELECT target FROM votes WHERE room_code = ${room} AND voter = ${player}`;
            const votesRaw = await sql`SELECT target, COUNT(*) as c FROM votes WHERE room_code = ${room} GROUP BY target`;
            
            const voteCounts = {};
            votesRaw.forEach(r => voteCounts[r.target] = r.c);
            const leaderObj = players.find(p => p.is_leader);

            return res.json({ 
                players: players.map(p => p.player_name),
                leader: leaderObj ? leaderObj.player_name : "",
                started: status.length > 0 ? status[0].started : false,
                seed: status.length > 0 ? status[0].game_seed : "default",
                ejected: status.length > 0 ? status[0].ejected_player : null,
                hasVoted: myVote.length > 0,
                votes: voteCounts
            });
        }

        // --- START ---
        if (action === 'start') {
            const check = await sql`SELECT is_leader FROM rooms WHERE room_code = ${room} AND player_name = ${player}`;
            if (check.length > 0 && check[0].is_leader) {
                await sql`UPDATE room_status SET started = TRUE WHERE room_code = ${room}`;
                return res.json({ msg: "Started" });
            }
        }

        // --- VOTE ---
        if (action === 'vote') {
            await sql`INSERT INTO votes (room_code, voter, target) VALUES (${room}, ${player}, ${target}) ON CONFLICT (room_code, voter) DO UPDATE SET target = ${target}`;
            const totalPlayers = await sql`SELECT COUNT(*) FROM rooms WHERE room_code = ${room}`;
            const totalVotes = await sql`SELECT COUNT(*) FROM votes WHERE room_code = ${room}`;
            if (parseInt(totalVotes[0].count) >= parseInt(totalPlayers[0].count)) {
                const results = await sql`SELECT target, COUNT(*) as count FROM votes WHERE room_code = ${room} GROUP BY target ORDER BY count DESC LIMIT 1`;
                if (results.length > 0) await sql`UPDATE room_status SET ejected_player = ${results[0].target} WHERE room_code = ${room}`;
            }
            return res.json({ msg: "Voted" });
        }

        // --- RESET ---
        if (action === 'reset') {
            const check = await sql`SELECT is_leader FROM rooms WHERE room_code = ${room} AND player_name = ${player}`;
            if (check.length > 0 && check[0].is_leader) {
                const newSeed = Math.random().toString(36).substring(7);
                await sql`DELETE FROM votes WHERE room_code = ${room}`;
                await sql`UPDATE room_status SET started = FALSE, game_seed = ${newSeed}, ejected_player = NULL WHERE room_code = ${room}`;
                return res.json({ msg: "Reset" });
            }
        }

    } catch (error) {
        console.error(error);
        res.status(500).send(String(error));
    }
});

// Arrancar el servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor Nakama listo en puerto ${PORT}`));
