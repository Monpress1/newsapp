// server.js
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// WebSocket server setup
// Use process.env.PORT for Render.com deployment
const PORT = process.env.PORT || 3000; // Use environment variable or fallback to 3000
const wss = new WebSocket.Server({ port: PORT });
console.log(`WebSocket server started on ws://localhost:${PORT}`);

// Database setup
// *** CRITICAL: For Render.com, SQLite in-memory or a persistent external DB is needed ***
// If you want to persist data, you MUST use an external database like PostgreSQL
// If using SQLite for testing/development, consider an in-memory database for Render
// For now, let's stick to the file but be aware of the ephemeral filesystem.
const DB_PATH = path.resolve(__dirname, 'news.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error connecting to database:', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initDb();
    }
});

/**
 * Initializes the database tables if they don't exist.
 */
function initDb() {
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS articles (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                imageUrl TEXT,
                timestamp INTEGER NOT NULL
            )
        `, (err) => {
            if (err) console.error('Error creating articles table:', err.message);
            else console.log('Articles table ensured.');
            // Add a test article if the table was just created and is empty
            db.get("SELECT COUNT(*) AS count FROM articles", (countErr, row) => {
                if (countErr) {
                    console.error("Error checking article count:", countErr.message);
                    return;
                }
                if (row.count === 0) {
                    console.log("No articles found, inserting a sample article...");
                    db.run(
                        "INSERT INTO articles (title, content, imageUrl, timestamp) VALUES (?, ?, ?, ?)",
                        ["Welcome to the News Hub!", "This is a sample article to show that the system is working. Add your own news!", "", Date.now()],
                        function(insertErr) {
                            if (insertErr) {
                                console.error("Error inserting sample article:", insertErr.message);
                            } else {
                                console.log("Sample article inserted with ID:", this.lastID);
                                // Broadcast the new article immediately if the server just started and added it
                                // This assumes clients are already connected, which might not be true right after startup
                                // Best practice: clients request ALL_ARTICLES on connect.
                            }
                        }
                    );
                }
            });
        });

        db.run(`
            CREATE TABLE IF NOT EXISTS comments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                article_id INTEGER NOT NULL,
                userName TEXT NOT NULL,
                commentText TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
            )
        `, (err) => {
            if (err) console.error('Error creating comments table:', err.message);
            else console.log('Comments table ensured.');
        });

        db.run(`
            CREATE TABLE IF NOT EXISTS reactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                article_id INTEGER NOT NULL,
                clientId TEXT NOT NULL,
                type TEXT NOT NULL, -- 'thumbs_up', 'love', 'sad'
                timestamp INTEGER NOT NULL,
                FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
            )
        `, (err) => {
            if (err) console.error('Error creating reactions table:', err.message);
            else console.log('Reactions table ensured.');
        });
    });
}

/**
 * Fetches all articles along with their comments and reactions.
 * @returns {Promise<Array>} A promise that resolves to an array of article objects.
 */
async function getAllArticles() {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM articles ORDER BY timestamp DESC", async (err, articles) => {
            if (err) {
                console.error("Error in getAllArticles DB query:", err.message); // Added logging
                return reject(err);
            }

            if (!articles || articles.length === 0) {
                console.log("No articles found in the database."); // Added logging
                return resolve([]); // Resolve with empty array if no articles
            }

            const articlesWithDetails = [];
            for (const article of articles) {
                const comments = await new Promise((res, rej) => {
                    db.all("SELECT userName, commentText, timestamp FROM comments WHERE article_id = ? ORDER BY timestamp ASC", [article.id], (err, rows) => {
                        if (err) {
                            console.error(`Error fetching comments for article ${article.id}:`, err.message); // Added logging
                            rej(err);
                        }
                        else res(rows);
                    });
                });

                const reactions = await new Promise((res, rej) => {
                    db.all("SELECT clientId, type, timestamp FROM reactions WHERE article_id = ?", [article.id], (err, rows) => {
                        if (err) {
                            console.error(`Error fetching reactions for article ${article.id}:`, err.message); // Added logging
                            rej(err);
                        }
                        else res(rows);
                    });
                });

                articlesWithDetails.push({
                    id: article.id,
                    title: article.title,
                    content: article.content,
                    imageUrl: article.imageUrl,
                    timestamp: article.timestamp,
                    comments: comments,
                    reactions: reactions
                });
            }
            resolve(articlesWithDetails);
        });
    });
}

/**
 * Adds a new article to the database.
 * @param {object} article - The article data.
 * @returns {Promise<object>} A promise that resolves to the inserted article with its ID.
 */
async function addArticle(article) {
    return new Promise((resolve, reject) => {
        db.run(
            "INSERT INTO articles (title, content, imageUrl, timestamp) VALUES (?, ?, ?, ?)",
            [article.title, article.content, article.imageUrl, article.timestamp],
            function(err) { // Use function() for 'this' context
                if (err) {
                    console.error("Error inserting article:", err.message); // Added logging
                    return reject(err);
                }
                console.log(`Article "${article.title}" inserted with ID: ${this.lastID}`); // Added logging
                resolve({ id: this.lastID, ...article });
            }
        );
    });
}

/**
 * Adds a new comment to the database.
 * @param {number} articleId - The ID of the article.
 * @param {object} comment - The comment data.
 * @returns {Promise<object>} A promise that resolves to the inserted comment.
 */
async function addComment(articleId, comment) {
    return new Promise((resolve, reject) => {
        db.run(
            "INSERT INTO comments (article_id, userName, commentText, timestamp) VALUES (?, ?, ?, ?)",
            [articleId, comment.userName, comment.commentText, comment.timestamp],
            function(err) {
                if (err) {
                    console.error("Error inserting comment:", err.message); // Added logging
                    return reject(err);
                }
                console.log(`Comment added for article ${articleId} by ${comment.userName}`); // Added logging
                resolve({ id: this.lastID, ...comment });
            }
        );
    });
}

/**
 * Adds a new reaction to the database.
 * @param {number} articleId - The ID of the article.
 * @param {object} reaction - The reaction data.
 * @returns {Promise<object>} A promise that resolves to the inserted reaction.
 */
async function addReaction(articleId, reaction) {
    return new Promise((resolve, reject) => {
        db.run(
            "INSERT INTO reactions (article_id, clientId, type, timestamp) VALUES (?, ?, ?, ?)",
            [articleId, reaction.clientId, reaction.type, reaction.timestamp],
            function(err) {
                if (err) {
                    console.error("Error inserting reaction:", err.message); // Added logging
                    return reject(err);
                }
                console.log(`Reaction '${reaction.type}' added for article ${articleId} by client ${reaction.clientId}`); // Added logging
                resolve({ id: this.lastID, ...reaction });
            }
        );
    });
}


/**
 * Sends a message to all connected WebSocket clients.
 * @param {object} message - The message object to send.
 */
function broadcast(message) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(JSON.stringify(message));
                // console.log('Broadcasted message:', message.type); // Optional: verbose logging
            } catch (error) {
                console.error('Error broadcasting message:', error);
            }
        }
    });
}

// WebSocket connection handling
wss.on('connection', async (ws) => {
    console.log('Client connected.');

    // Send all existing articles to the newly connected client
    try {
        const articles = await getAllArticles();
        console.log(`Server: Found ${articles.length} articles to send on new connection.`); // Added logging
        ws.send(JSON.stringify({ type: 'ALL_ARTICLES', articles: articles }));
        console.log('Server: Sent ALL_ARTICLES to new client.'); // Added logging
    } catch (error) {
        console.error('Error sending initial articles:', error);
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to load articles.' }));
    }

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Received:', data.type, 'from client');

            switch (data.type) {
                case 'PUBLISH_ARTICLE':
                    console.log('Server: Processing PUBLISH_ARTICLE request...'); // Added logging
                    const newArticle = await addArticle(data.article);
                    // Broadcast the newly published article (with its ID from DB) to all clients
                    broadcast({ type: 'NEW_ARTICLE', article: newArticle });
                    console.log('Server: Broadcasted NEW_ARTICLE.'); // Added logging
                    break;
                case 'POST_COMMENT':
                    console.log('Server: Processing POST_COMMENT request...'); // Added logging
                    const { articleId: commentArticleId, comment } = data;
                    const addedComment = await addComment(commentArticleId, comment);
                    // Broadcast the new comment to all clients
                    broadcast({ type: 'NEW_COMMENT', articleId: commentArticleId, comment: addedComment });
                    console.log('Server: Broadcasted NEW_COMMENT.'); // Added logging
                    break;
                case 'POST_REACTION':
                    console.log('Server: Processing POST_REACTION request...'); // Added logging
                    const { articleId: reactionArticleId, reaction } = data;
                    const addedReaction = await addReaction(reactionArticleId, reaction);
                    // Broadcast the new reaction to all clients
                    broadcast({ type: 'NEW_REACTION', articleId: reactionArticleId, reaction: addedReaction });
                    console.log('Server: Broadcasted NEW_REACTION.'); // Added logging
                    break;
                case 'GET_ALL_ARTICLES': // This case is primarily for initial connection, but kept for clarity
                    console.log('Server: Processing GET_ALL_ARTICLES request (on message)...'); // Added logging
                    const articles = await getAllArticles();
                    console.log(`Server: Found ${articles.length} articles to send for GET_ALL_ARTICLES message.`); // Added logging
                    ws.send(JSON.stringify({ type: 'ALL_ARTICLES', articles: articles }));
                    console.log('Server: Sent ALL_ARTICLES in response to GET_ALL_ARTICLES message.'); // Added logging
                    break;
                default:
                    console.warn('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('Error processing message:', error);
            // Send a more detailed error message if possible (avoid exposing sensitive details)
            ws.send(JSON.stringify({ type: 'ERROR', message: `Server error: ${error.message || 'Unknown error.'}` }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected.');
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});
