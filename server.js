// server.js

const WebSocket = require('ws');
const http = require('http');
const sqlite3 = require('sqlite3').verbose(); // Import sqlite3 and enable verbose mode
const util = require('util'); // Node.js utility module for promisify

// --- SQLite Database Connection ---
// The database file will be created if it doesn't exist
const DB_PATH = './news.db';
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error connecting to SQLite database:', err.message);
        process.exit(1); // Exit if database connection fails
    } else {
        console.log('Connected to the SQLite database.');
    }
});

// Promisify SQLite methods for async/await usage
db.run = util.promisify(db.run);
db.get = util.promisify(db.get);
db.all = util.promisify(db.all);

async function connectDb() {
    try {
        // We already connected to the database in the initialization above.
        // This function will now primarily ensure tables exist and categories are initialized.
        await createTables(); // Ensure tables exist on connect
        await initializeCategories(); // Ensure default categories exist
    } catch (err) {
        console.error('Error setting up SQLite database:', err.message);
        process.exit(1); // Exit if setup fails
    }
}

// --- Database Schema Setup ---
async function createTables() {
    // SQLite uses INTEGER PRIMARY KEY AUTOINCREMENT for auto-incrementing IDs
    // TEXT is generally used for strings, INTEGER for numbers (including timestamps)
    // FOREIGN KEY constraints are supported.

    const createCategoriesTable = `
        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL
        );
    `;

    const createArticlesTable = `
        CREATE TABLE IF NOT EXISTS articles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            image_url TEXT,
            timestamp INTEGER NOT NULL, -- Storing timestamp as INTEGER (milliseconds since epoch)
            category_id INTEGER,
            FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE SET NULL
        );
    `;

    const createCommentsTable = `
        CREATE TABLE IF NOT EXISTS comments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            article_id INTEGER NOT NULL,
            user_name TEXT,
            comment_text TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
        );
    `;

    const createReactionsTable = `
        CREATE TABLE IF NOT EXISTS reactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            article_id INTEGER NOT NULL,
            type TEXT NOT NULL, -- e.g., 'like', 'heart'
            client_id TEXT NOT NULL, -- Unique identifier for the client/user
            timestamp INTEGER NOT NULL,
            UNIQUE(article_id, client_id, type), -- Prevents same user/same type multiple reactions
            FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
        );
    `;

    try {
        await db.run(createCategoriesTable);
        await db.run(createArticlesTable);
        await db.run(createCommentsTable);
        await db.run(createReactionsTable);
        console.log('SQLite database tables ensured (created if not exist).');
    } catch (err) {
        console.error('Error creating tables:', err.message);
        throw err; // Re-throw to stop server if tables can't be created
    }
}

// --- Initialize Default Categories ---
async function initializeCategories() {
    const defaultCategories = [
        { name: "General" },
        { name: "Politics" },
        { name: "Technology" },
        { name: "Sports" },
        { name: "Business" },
        { name: "Entertainment" },
        { name: "Health" }
    ];

    try {
        for (const cat of defaultCategories) {
            // SQLite UPSERT logic: INSERT OR IGNORE
            // If a row with the same unique 'name' already exists, the insert is ignored.
            await db.run(`INSERT OR IGNORE INTO categories (name) VALUES (?)`, [cat.name]);
        }
        console.log('Default categories initialized/ensured.');
    } catch (err) {
        console.error('Error initializing categories:', err.message);
    }
}


// --- WebSocket Server Setup ---

// Create a simple HTTP server to allow WebSocket server to listen
const server = http.createServer((req, res) => {
    // This server can also serve static files if needed, but for now, it's minimal
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('WebSocket server for Global News Hub is running.');
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// Create WebSocket server attached to the HTTP server
const wss = new WebSocket.Server({ server });

wss.on('connection', async ws => {
    console.log('Client connected');

    try {
        // Fetch all articles
        const articlesRows = await db.all(`
            SELECT
                a.id,
                a.title,
                a.content,
                a.image_url,
                a.timestamp,
                a.category_id,
                c.name AS category_name
            FROM articles a
            LEFT JOIN categories c ON a.category_id = c.id
            ORDER BY a.timestamp DESC;
        `);

        // Fetch all comments and group them by article_id
        const commentsRows = await db.all(`SELECT id, article_id, user_name, comment_text, timestamp FROM comments`);
        const commentsByArticle = commentsRows.reduce((acc, comment) => {
            if (!acc[comment.article_id]) {
                acc[comment.article_id] = [];
            }
            acc[comment.article_id].push({
                id: comment.id,
                userName: comment.user_name,
                commentText: comment.comment_text,
                timestamp: comment.timestamp
            });
            return acc;
        }, {});

        // Fetch all reactions and group them by article_id
        const reactionsRows = await db.all(`SELECT id, article_id, type, client_id, timestamp FROM reactions`);
        const reactionsByArticle = reactionsRows.reduce((acc, reaction) => {
            if (!acc[reaction.article_id]) {
                acc[reaction.article_id] = [];
            }
            acc[reaction.article_id].push({
                id: reaction.id,
                type: reaction.type,
                clientId: reaction.client_id,
                timestamp: reaction.timestamp
            });
            return acc;
        }, {});

        // Combine articles with their comments and reactions
        const articles = articlesRows.map(row => ({
            id: row.id,
            title: row.title,
            content: row.content,
            imageUrl: row.image_url,
            timestamp: parseInt(row.timestamp), // Ensure timestamp is a number
            categoryId: row.category_id,
            category: row.category_id ? { id: row.category_id, name: row.category_name } : null,
            comments: commentsByArticle[row.id] || [], // Attach comments, default to empty array
            reactions: reactionsByArticle[row.id] || [] // Attach reactions, default to empty array
        }));

        // Fetch all categories for the client's dropdown
        const categories = await db.all('SELECT id, name FROM categories ORDER BY name');

        // Send initial data to the newly connected client
        ws.send(JSON.stringify({
            type: 'INITIAL_DATA',
            articles: articles,
            categories: categories
        }));

    } catch (error) {
        console.error('Error fetching initial data from DB:', error.message);
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to load initial data.' }));
    }


    ws.on('message', async message => {
        try {
            const data = JSON.parse(message);
            console.log('Received:', data.type); // Log the message type received

            switch (data.type) {
                case 'PUBLISH_ARTICLE':
                    const { title, content, imageUrl, categoryId } = data.article;
                    const timestamp = Date.now(); // Server sets the timestamp

                    // Insert the new article into the database
                    const insertArticleResult = await db.run(
                        `INSERT INTO articles (title, content, image_url, timestamp, category_id)
                         VALUES (?, ?, ?, ?, ?)`,
                        [title, content, imageUrl, timestamp, categoryId]
                    );
                    const newArticleId = insertArticleResult.lastID; // Get the ID of the newly inserted row

                    // Fetch the newly inserted article to get all its fields, including the generated ID
                    const newArticleRow = await db.get(`
                        SELECT
                            a.id,
                            a.title,
                            a.content,
                            a.image_url,
                            a.timestamp,
                            a.category_id,
                            c.name AS category_name
                        FROM articles a
                        LEFT JOIN categories c ON a.category_id = c.id
                        WHERE a.id = ?`, [newArticleId]);

                    // Format the new article data for broadcasting to clients
                    const newArticle = {
                        id: newArticleRow.id,
                        title: newArticleRow.title,
                        content: newArticleRow.content,
                        imageUrl: newArticleRow.image_url,
                        timestamp: parseInt(newArticleRow.timestamp), // Ensure timestamp is a number
                        categoryId: newArticleRow.category_id,
                        category: newArticleRow.category_id ? { id: newArticleRow.category_id, name: newArticleRow.category_name } : null,
                        comments: [], // Newly published article has no comments initially
                        reactions: [] // Newly published article has no reactions initially
                    };

                    // Broadcast the new article to all connected clients
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'NEW_ARTICLE', article: newArticle }));
                        }
                    });
                    break;

                case 'POST_COMMENT':
                    const articleIdForComment = data.articleId;
                    const { userName, commentText } = data.comment;
                    const commentTimestamp = Date.now(); // Server sets the timestamp

                    // Insert the new comment into the database
                    const insertCommentResult = await db.run(
                        `INSERT INTO comments (article_id, user_name, comment_text, timestamp)
                         VALUES (?, ?, ?, ?)`,
                        [articleIdForComment, userName || 'Anonymous', commentText, commentTimestamp]
                    );
                    const newCommentId = insertCommentResult.lastID;

                    // Format the new comment data for broadcasting to clients
                    const newComment = {
                        id: newCommentId,
                        userName: userName || 'Anonymous',
                        commentText: commentText,
                        timestamp: parseInt(commentTimestamp) // Ensure timestamp is a number
                    };

                    // Broadcast the new comment to all connected clients
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'NEW_COMMENT', articleId: articleIdForComment, comment: newComment }));
                        }
                    });
                    break;

                case 'POST_REACTION':
                    const articleIdForReaction = data.articleId;
                    const { type: reactionType, clientId } = data.reaction;
                    const reactionTimestamp = Date.now(); // Server sets the timestamp

                    try {
                        // Attempt to insert the reaction.
                        // SQLite's INSERT OR IGNORE will prevent duplicates based on the UNIQUE constraint.
                        const insertReactionResult = await db.run(
                            `INSERT OR IGNORE INTO reactions (article_id, type, client_id, timestamp)
                             VALUES (?, ?, ?, ?)`,
                            [articleIdForReaction, reactionType, clientId, reactionTimestamp]
                        );

                        if (insertReactionResult.changes > 0) {
                            // If changes > 0, the insert was successful
                            const newReactionId = insertReactionResult.lastID;

                            // Format the new reaction data for broadcasting to clients
                            const newReaction = {
                                id: newReactionId,
                                type: reactionType,
                                clientId: clientId,
                                timestamp: parseInt(reactionTimestamp) // Ensure timestamp is a number
                            };

                            // Broadcast the new reaction to all connected clients
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({ type: 'NEW_REACTION', articleId: articleIdForReaction, reaction: newReaction }));
                                }
                            });
                        } else {
                            // If changes is 0, it means the INSERT OR IGNORE was ignored due to a unique constraint violation
                            ws.send(JSON.stringify({ type: 'ERROR', message: 'You have already reacted with this type.' }));
                            console.log(`Client ${clientId} tried to add duplicate reaction '${reactionType}' to article ${articleIdForReaction}.`);
                        }
                    } catch (error) {
                        // Catch other potential database errors (though INSERT OR IGNORE handles the common one)
                        console.error('Error posting reaction to DB:', error.message);
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to post reaction due to server error.' }));
                    }
                    break;

                default:
                    // If an unknown message type is received
                    ws.send(JSON.stringify({ type: 'ERROR', message: `Unknown message type: ${data.type}` }));
                    console.warn(`Received unknown message type: ${data.type}`);
                    break;
            }
        } catch (error) {
            // Catch errors during JSON parsing or general request processing
            console.error('Error parsing message or processing request:', error.message);
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid message format or server error.' }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    ws.on('error', error => {
        console.error('WebSocket error:', error.message);
    });
});

// Connect to the database first, then start the server
connectDb();

// Define the port, using process.env.PORT for Render deployment
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(`WebSocket server running on ws://localhost:${PORT}`);
});

// Gracefully close the database connection when the app exits
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err.message);
        }
        console.log('SQLite database connection closed.');
        process.exit(0);
    });
});
