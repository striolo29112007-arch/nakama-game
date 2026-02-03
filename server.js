const express = require('express');
const cors = require('cors');
const { neon } = require('@neondatabase/serverless');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname)); 

const sql = neon(process.env.DATABASE_URL);

app.post('/api', async (req, res) => {
    // Eliminado customWord de los inputs
    let { action, room, player, target, gameMode, content, replyTo } = req.body;
    
    if(room) room = room.trim().toUpperCase();
    if(player) player = player.trim().toUpperCase();

    try {
        if (action === 'list') {
            const rooms = await sql`SELECT room_code, COUNT(*) as count, MAX(created_at) as created_at FROM rooms GROUP BY room_code ORDER BY created_at DESC LIMIT 10`;
            return res.json(rooms);
        }

        if (action === 'join') {
            const existing = await sql`SELECT * FROM rooms WHERE room_code = ${room}`;
            let isStale = false;
            if (existing.length > 0) {
                const diffMinutes = (new Date() - new Date(existing[0].created_at)) / 1000 / 60;
                if (diffMinutes > 30) isStale = true;
            }

            if (existing.length === 0 || isStale) {
                const randomSeed = Math.random().toString(36).substring(7);
                // Limpiamos todo al crear sala nueva
                await sql`DELETE FROM room_status WHERE room_code = ${room}`;
                await sql`DELETE FROM votes WHERE room_code = ${room}`;
                await sql`DELETE FROM rooms WHERE room_code = ${room}`;
                await sql`DELETE FROM messages WHERE room_code = ${room}`; // Limpiar chat antiguo
                
                await sql`INSERT INTO room_status (room_code, started, game_seed, ejected_player) VALUES (${room}, FALSE, ${randomSeed}, NULL)`;
                await sql`INSERT INTO rooms (room_code, player_name, is_leader) VALUES (${room}, ${player}, TRUE)`;
            } else {
                const nameExists = existing.some(p => p.player_name === player);
                if (nameExists) return res.json({ msg: "Reconnected" }); 
                await sql`INSERT INTO rooms (room_code, player_name, is_leader) VALUES (${room}, ${player}, FALSE)`;
            }
            return res.json({ msg: "Ok" });
        }

        if (action === 'get') {
            const players = await sql`SELECT player_name, is_leader FROM rooms WHERE room_code = ${room}`;
            if (players.length === 0) return res.json({ restart: true });

            const amIHere = players.some(p => p.player_name === player);
            if (!amIHere) return res.json({ restart: true });

            const status = await sql`SELECT started, game_seed, ejected_player FROM room_status WHERE room_code = ${room}`;
            const myVote = await sql`SELECT target FROM votes WHERE room_code = ${room} AND voter = ${player}`;
            const votesRaw = await sql`SELECT target, COUNT(*) as c FROM votes WHERE room_code = ${room} GROUP BY target`;
            
            const voteCounts = {};
            votesRaw.forEach(r => voteCounts[r.target] = parseInt(r.c));
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

        // --- CHAT: ENVIAR ---
        if (action === 'send_message') {
            if (content && content.trim().length > 0) {
                await sql`INSERT INTO messages (room_code, player_name, content, reply_to) VALUES (${room}, ${player}, ${content}, ${replyTo || null})`;
                return res.json({ msg: "Sent" });
            }
        }

        // --- CHAT: LEER ---
        if (action === 'get_messages') {
            // Traemos los últimos 50 mensajes
            const msgs = await sql`SELECT id, player_name, content, reply_to, created_at FROM messages WHERE room_code = ${room} ORDER BY created_at ASC LIMIT 50`;
            return res.json(msgs);
        }

        // --- START (SIN PALABRA CUSTOM) ---
        if (action === 'start') {
            const check = await sql`SELECT is_leader FROM rooms WHERE room_code = ${room} AND player_name = ${player}`;
            if (check.length > 0 && check[0].is_leader) {
                let finalSeed = Math.random().toString(36).substring(7);
                
                // Semilla: RANDOM | NONE | MODO | EVENTO
                // (Ya no leemos customWord, siempre es NONE)
                finalSeed += "|NONE"; 

                const selectedMode = gameMode || "CLASSIC";
                finalSeed += "|" + selectedMode;

                if (selectedMode === "AKUMA" && Math.random() < 0.15) {
                     finalSeed += "|EVENT_ROOM"; 
                } else {
                     finalSeed += "|NO_EVENT";
                }

                await sql`UPDATE room_status SET started = TRUE, game_seed = ${finalSeed} WHERE room_code = ${room}`;
                return res.json({ msg: "Started" });
            }
        }

        if (action === 'vote') {
            await sql`INSERT INTO votes (room_code, voter, target) VALUES (${room}, ${player}, ${target}) ON CONFLICT (room_code, voter) DO UPDATE SET target = ${target}`;
            const totalPlayers = await sql`SELECT COUNT(*) FROM rooms WHERE room_code = ${room}`;
            const totalVotes = await sql`SELECT COUNT(*) FROM votes WHERE room_code = ${room}`;
            
            if (parseInt(totalVotes[0].count) >= parseInt(totalPlayers[0].count)) {
                const results = await sql`SELECT target, COUNT(*) as count FROM votes WHERE room_code = ${room} GROUP BY target ORDER BY count DESC`;
                let ejected = 'SKIP';
                
                if (results.length > 0) {
                    const maxVotes = parseInt(results[0].count);
                    const ties = results.filter(r => parseInt(r.count) === maxVotes);
                    if (ties.length === 1) {
                        ejected = ties[0].target;
                    } else {
                        const randomLoser = ties[Math.floor(Math.random() * ties.length)];
                        ejected = randomLoser.target;
                    }
                }
                await sql`UPDATE room_status SET ejected_player = ${ejected} WHERE room_code = ${room}`;
            }
            return res.json({ msg: "Voted" });
        }

        if (action === 'reset') {
            const check = await sql`SELECT is_leader FROM rooms WHERE room_code = ${room} AND player_name = ${player}`;
            if (check.length > 0 && check[0].is_leader) {
                const newSeed = Math.random().toString(36).substring(7);
                await sql`DELETE FROM votes WHERE room_code = ${room}`;
                await sql`UPDATE room_status SET started = FALSE, game_seed = ${newSeed}, ejected_player = NULL WHERE room_code = ${room}`;
                return res.json({ msg: "Reset" });
            }
        }
        
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
        }

    } catch (error) { res.status(500).send(String(error)); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor Nakama listo en puerto ${PORT}`));
