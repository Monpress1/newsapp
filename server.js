const WebSocket = require('ws');
const http = require('http');
const { Client } = require('pg'); // PostgreSQL client
require('dotenv').config(); // For loading environment variables (like DB URL for local dev)

// --- PostgreSQL Connection ---
// Render will automatically set process.env.DATABASE_URL
// For local development, ensure you have a .env file with DATABASE_URL
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
    console.error('DATABASE_URL environment variable is not set. Please set it for local development or in Render environment.');
    process.exit(1); // Exit if no database URL
}

const pgClient = new Client({
    connectionString: DATABASE_URL,
    ssl: {
        // Required for Render's managed PostgreSQL to work, especially if connecting from local
        // or between Render services without specific CA certs.
        rejectUnauthorized: false
    }
});

async function connectDb() {
    try {
        await pgClient.connect();
        console.log('Connected to PostgreSQL database');
        await createTables(); // Ensure tables exist on connect
        await initializeCategories(); // Ensure default categories exist
    } catch (err) {
        console.error('Error connecting to PostgreSQL:', err.message);
        // In a production app, you might want more sophisticated reconnection logic
        process.exit(1); // Exit if database connection fails
    }
}

// --- Database Schema Setup ---
async function createTables() {
    const createCategoriesTable = `
        CREATE TABLE IF NOT EXISTS categories (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) UNIQUE NOT NULL
        );
    `;

    // Articles table
    const createArticlesTable = `
        CREATE TABLE IF NOT EXISTS articles (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            content TEXT NOT NULL,
            image_url TEXT,
            timestamp BIGINT NOT NULL,
            category_id INT,
            FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE SET NULL
        );
    `;

    // Comments table
    const createCommentsTable = `
        CREATE TABLE IF NOT EXISTS comments (
            id SERIAL PRIMARY KEY,
            article_id INT NOT NULL,
            user_name VARCHAR(255),
            comment_text TEXT NOT NULL,
            timestamp BIGINT NOT NULL,
            FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
        );
    `;

    // Reactions table
    const createReactionsTable = `
        CREATE TABLE IF NOT EXISTS reactions (
            id SERIAL PRIMARY KEY,
            article_id INT NOT NULL,
            type VARCHAR(50) NOT NULL,
            client_id VARCHAR(255) NOT NULL,
            timestamp BIGINT NOT NULL,
            UNIQUE(article_id, client_id, type), -- Prevents same user/same type multiple reactions
            FOREIGN KEY (article_id) REFERENCES articles (id) ON DELETE CASCADE
        );
    `;

    try {
        await pgClient.query(createCategoriesTable);
        await pgClient.query(createArticlesTable);
        await pgClient.query(createCommentsTable);
        await pgClient.query(createReactionsTable);
        console.log('Database tables ensured (created if not exist).');
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
            // UPSERT logic: Insert if not exists, do nothing if it does
            await pgClient.query(
                `INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
                [cat.name]
            );
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
        // Fetch all articles from PostgreSQL, including nested comments and reactions
        // and join with category name.
        const result = await pgClient.query(`
            SELECT
                a.id,
                a.title,
                a.content,
                a.image_url,
                a.timestamp,
                a.category_id,
                c.name AS category_name,
                (SELECT JSON_AGG(json_build_object('id', co.id, 'userName', co.user_name, 'commentText', co.comment_text, 'timestamp', co.timestamp))
                 FROM comments co WHERE co.article_id = a.id) AS comments,
                (SELECT JSON_AGG(json_build_object('id', r.id, 'type', r.type, 'clientId', r.client_id, 'timestamp', r.timestamp))
                 FROM reactions r WHERE r.article_id = a.id) AS reactions
            FROM articles a
            LEFT JOIN categories c ON a.category_id = c.id
            ORDER BY a.timestamp DESC;
        `);

        // Transform data to match client's expected JavaScript object structure
        const articles = result.rows.map(row => ({
            id: row.id,
            title: row.title,
            content: row.content,
            imageUrl: row.image_url,
            timestamp: parseInt(row.timestamp), // Ensure timestamp is a number
            categoryId: row.category_id,
            category: row.category_id ? { id: row.category_id, name: row.category_name } : null,
            comments: row.comments || [], // Ensure it's an empty array if no comments
            reactions: row.reactions || [] // Ensure it's an empty array if no reactions
        }));

        // Fetch all categories for the client's dropdown
        const categoriesResult = await pgClient.query('SELECT id, name FROM categories ORDER BY name');
        const categories = categoriesResult.rows;

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
                    const insertArticleResult = await pgClient.query(
                        `INSERT INTO articles (title, content, image_url, timestamp, category_id)
                         VALUES ($1, $2, $3, $4, $5) RETURNING *`, // RETURNING * gets the inserted row
                        [title, content, imageUrl, timestamp, categoryId]
                    );
                    const newArticleRow = insertArticleResult.rows[0]; // The newly inserted article row

                    // Fetch category name for the article to send back to client
                    let categoryName = null;
                    if (newArticleRow.category_id) {
                        const categoryResult = await pgClient.query('SELECT name FROM categories WHERE id = $1', [newArticleRow.category_id]);
                        if (categoryResult.rows.length > 0) {
                            categoryName = categoryResult.rows[0].name;
                        }
                    }

                    // Format the new article data for broadcasting to clients
                    const newArticle = {
                        id: newArticleRow.id,
                        title: newArticleRow.title,
                        content: newArticleRow.content,
                        imageUrl: newArticleRow.image_url,
                        timestamp: parseInt(newArticleRow.timestamp), // Ensure timestamp is a number
                        categoryId: newArticleRow.category_id,
                        category: newArticleRow.category_id ? { id: newArticleRow.category_id, name: categoryName } : null,
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
                    const insertCommentResult = await pgClient.query(
                        `INSERT INTO comments (article_id, user_name, comment_text, timestamp)
                         VALUES ($1, $2, $3, $4) RETURNING *`,
                        [articleIdForComment, userName || 'Anonymous', commentText, commentTimestamp]
                    );
                    const newCommentRow = insertCommentResult.rows[0]; // The newly inserted comment row

                    // Format the new comment data for broadcasting to clients
                    const newComment = {
                        id: newCommentRow.id,
                        userName: newCommentRow.user_name,
                        commentText: newCommentRow.comment_text,
                        timestamp: parseInt(newCommentRow.timestamp) // Ensure timestamp is a number
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
                    // Renamed 'type' to 'reactionType' to avoid conflict with the message 'type'
                    const { type: reactionType, clientId } = data.reaction;
                    const reactionTimestamp = Date.now(); // Server sets the timestamp

                    try {
                        // Attempt to insert the reaction.
                        // The UNIQUE constraint on (article_id, client_id, type) in the DB
                        // will automatically prevent duplicate reactions from the same user for the same type.
                        const insertReactionResult = await pgClient.query(
                            `INSERT INTO reactions (article_id, type, client_id, timestamp)
                             VALUES ($1, $2, $3, $4) RETURNING *`,
                            [articleIdForReaction, reactionType, clientId, reactionTimestamp]
                        );
                        const newReactionRow = insertReactionResult.rows[0]; // The newly inserted reaction row

                        // Format the new reaction data for broadcasting to clients
                        const newReaction = {
                            id: newReactionRow.id,
                            type: newReactionRow.type,
                            clientId: newReactionRow.client_id,
                            timestamp: parseInt(newReactionRow.timestamp) // Ensure timestamp is a number
                        };

                        // Broadcast the new reaction to all connected clients
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({ type: 'NEW_REACTION', articleId: articleIdForReaction, reaction: newReaction }));
                            }
                        });
                    } catch (error) {
                        // Check for unique constraint violation (PostgreSQL error code '23505')
                        if (error.code === '23505') {
                            // This means the user already reacted with this type on this article
                            ws.send(JSON.stringify({ type: 'ERROR', message: 'You have already reacted with this type.' }));
                            console.log(`Client ${clientId} tried to add duplicate reaction '${reactionType}' to article ${articleIdForReaction}.`);
                        } else {
                            // Other database errors
                            console.error('Error posting reaction to DB:', error.message);
                            ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to post reaction due to server error.' }));
                        }
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
