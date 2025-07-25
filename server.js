// server.js
const WebSocket = require('ws');
const { Pool } = require('pg');
const path = require('path');

// WebSocket server setup
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });
console.log(`WebSocket server started on ws://localhost:${PORT}`);

// --- PostgreSQL Database setup ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Connect and initialize database
async function connectAndInitDb() {
    let client;
    try {
        client = await pool.connect();
        console.log('Connected to PostgreSQL database.');

        // 1. Create categories table
        await client.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            );
        `);
        console.log('Categories table ensured.');

        // Insert default categories if none exist (optional, but good for starting)
        const categoriesCountResult = await client.query("SELECT COUNT(*) AS count FROM categories;");
        if (parseInt(categoriesCountResult.rows[0].count) === 0) {
            console.log("No categories found, inserting default categories...");
            await client.query(`
                INSERT INTO categories (name) VALUES
                ('General'), ('Technology'), ('Sports'), ('Politics'), ('Entertainment')
                ON CONFLICT (name) DO NOTHING;
            `);
            console.log("Default categories inserted.");
        }


        // 2. Create articles table (modified to include category_id)
        await client.query(`
            CREATE TABLE IF NOT EXISTS articles (
                id SERIAL PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                imageUrl TEXT,
                timestamp BIGINT NOT NULL,
                category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL -- Link to categories
            );
        `);
        console.log('Articles table ensured.');

        // --- REMOVED TEST ARTICLE INSERTION LOGIC ---
        // The previous block for inserting a sample article if the table was empty has been removed.
        // If you need a sample article, you'll publish it through your client now.

        // 3. Create comments table
        await client.query(`
            CREATE TABLE IF NOT EXISTS comments (
                id SERIAL PRIMARY KEY,
                article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
                userName TEXT NOT NULL,
                commentText TEXT NOT NULL,
                timestamp BIGINT NOT NULL
            );
        `);
        console.log('Comments table ensured.');

        // 4. Create reactions table
        await client.query(`
            CREATE TABLE IF NOT EXISTS reactions (
                id SERIAL PRIMARY KEY,
                article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
                clientId TEXT NOT NULL,
                type TEXT NOT NULL, -- 'thumbs_up', 'love', 'sad'
                timestamp BIGINT NOT NULL
            );
        `);
        console.log('Reactions table ensured.');

    } catch (err) {
        console.error('Error connecting or initializing PostgreSQL:', err.message);
        process.exit(1);
    } finally {
        if (client) {
            client.release();
        }
    }
}

connectAndInitDb();

// --- New function to get all categories ---
async function getAllCategories() {
    const client = await pool.connect();
    try {
        const result = await client.query("SELECT id, name FROM categories ORDER BY name ASC;");
        return result.rows;
    } catch (err) {
        console.error("Error fetching categories:", err.message);
        throw err;
    } finally {
        if (client) {
            client.release();
        }
    }
}


// --- Database interaction functions (using pg.Pool) ---

/**
 * Fetches all articles along with their comments, reactions, and category.
 * @returns {Promise<Array>} A promise that resolves to an array of article objects.
 */
async function getAllArticles() {
    const client = await pool.connect();
    try {
        // Fetch all articles, joining with categories to get the category name
        const articlesResult = await client.query(`
            SELECT
                a.id, a.title, a.content, a.imageUrl, a.timestamp,
                c.id AS category_id, c.name AS category_name
            FROM articles a
            LEFT JOIN categories c ON a.category_id = c.id
            ORDER BY a.timestamp DESC;
        `);
        const articles = articlesResult.rows;

        if (!articles || articles.length === 0) {
            console.log("No articles found in the database (PostgreSQL).");
            return [];
        }

        const articlesWithDetails = [];
        for (const article of articles) {
            // Fetch comments for each article
            const commentsResult = await client.query(
                "SELECT userName, commentText, timestamp FROM comments WHERE article_id = $1 ORDER BY timestamp ASC;",
                [article.id]
            );
            const comments = commentsResult.rows;

            // Fetch reactions for each article
            const reactionsResult = await client.query(
                "SELECT clientId, type, timestamp FROM reactions WHERE article_id = $1;",
                [article.id]
            );
            const reactions = reactionsResult.rows;

            articlesWithDetails.push({
                id: article.id,
                title: article.title,
                content: article.content,
                imageUrl: article.imageUrl,
                timestamp: article.timestamp,
                category: article.category_name ? { id: article.category_id, name: article.category_name } : null, // Include category object
                comments: comments,
                reactions: reactions
            });
        }
        return articlesWithDetails;
    } catch (err) {
        console.error("Error in getAllArticles (PostgreSQL):", err.message);
        throw err;
    } finally {
        if (client) {
            client.release();
        }
    }
}

/**
 * Adds a new article to the database.
 * @param {object} article - The article data.
 * @param {number} [article.categoryId] - Optional: The ID of the category this article belongs to.
 * @returns {Promise<object>} A promise that resolves to the inserted article with its ID and category details.
 */
async function addArticle(article) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            "INSERT INTO articles (title, content, imageUrl, timestamp, category_id) VALUES ($1, $2, $3, $4, $5) RETURNING id;",
            [article.title, article.content, article.imageUrl, article.timestamp, article.categoryId || null] // categoryId can be null
        );
        const newId = result.rows[0].id;

        let categoryDetails = null;
        if (article.categoryId) {
            const categoryResult = await client.query("SELECT id, name FROM categories WHERE id = $1;", [article.categoryId]);
            if (categoryResult.rows.length > 0) {
                categoryDetails = categoryResult.rows[0];
            }
        }

        console.log(`Article "${article.title}" inserted with ID: ${newId}`);
        return { id: newId, ...article, category: categoryDetails }; // Return category details with the new article
    } catch (err) {
        console.error("Error inserting article (PostgreSQL):", err.message);
        throw err;
    } finally {
        if (client) {
            client.release();
        }
    }
}

/**
 * Adds a new comment to the database.
 * @param {number} articleId - The ID of the article.
 * @param {object} comment - The comment data.
 * @returns {Promise<object>} A promise that resolves to the inserted comment.
 */
async function addComment(articleId, comment) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            "INSERT INTO comments (article_id, userName, commentText, timestamp) VALUES ($1, $2, $3, $4) RETURNING id;",
            [articleId, comment.userName, comment.commentText, comment.timestamp]
        );
        const newId = result.rows[0].id;
        console.log(`Comment added for article ${articleId} by ${comment.userName}`);
        return { id: newId, ...comment };
    } catch (err) {
        console.error("Error inserting comment (PostgreSQL):", err.message);
        throw err;
    } finally {
        if (client) {
            client.release();
        }
    }
}

/**
 * Adds a new reaction to the database.
 * @param {number} articleId - The ID of the article.
 * @param {object} reaction - The reaction data.
 * @returns {Promise<object>} A promise that resolves to the inserted reaction.
 */
async function addReaction(articleId, reaction) {
    const client = await pool.connect();
    try {
        const result = await client.query(
            "INSERT INTO reactions (article_id, clientId, type, timestamp) VALUES ($1, $2, $3, $4) RETURNING id;",
            [articleId, reaction.clientId, reaction.type, reaction.timestamp]
        );
        const newId = result.rows[0].id;
        console.log(`Reaction '${reaction.type}' added for article ${articleId} by client ${reaction.clientId}`);
        return { id: newId, ...reaction };
    } catch (err) {
        console.error("Error inserting reaction (PostgreSQL):", err.message);
        throw err;
    } finally {
        if (client) {
            client.release();
        }
    }
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
            } catch (error) {
                console.error('Error broadcasting message:', error);
            }
        }
    });
}

// WebSocket connection handling
wss.on('connection', async (ws) => {
    console.log('Client connected.');

    // Send all existing articles AND categories to the newly connected client
    try {
        const articles = await getAllArticles();
        const categories = await getAllCategories(); // Fetch categories
        console.log(`Server: Found ${articles.length} articles and ${categories.length} categories to send on new connection.`);
        ws.send(JSON.stringify({
            type: 'INITIAL_DATA', // New type to send both
            articles: articles,
            categories: categories
        }));
        console.log('Server: Sent INITIAL_DATA to new client.');
    } catch (error) {
        console.error('Error sending initial data:', error);
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Failed to load initial data.' }));
    }

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);
            console.log('Received:', data.type, 'from client');

            switch (data.type) {
                case 'PUBLISH_ARTICLE':
                    console.log('Server: Processing PUBLISH_ARTICLE request...');
                    // The client needs to send categoryId in data.article
                    const newArticle = await addArticle(data.article);
                    broadcast({ type: 'NEW_ARTICLE', article: newArticle });
                    console.log('Server: Broadcasted NEW_ARTICLE.');
                    break;
                case 'POST_COMMENT':
                    console.log('Server: Processing POST_COMMENT request...');
                    const { articleId: commentArticleId, comment } = data;
                    const addedComment = await addComment(commentArticleId, comment);
                    broadcast({ type: 'NEW_COMMENT', articleId: commentArticleId, comment: addedComment });
                    console.log('Server: Broadcasted NEW_COMMENT.');
                    break;
                case 'POST_REACTION':
                    console.log('Server: Processing POST_REACTION request...');
                    const { articleId: reactionArticleId, reaction } = data;
                    const addedReaction = await addReaction(reactionArticleId, reaction);
                    broadcast({ type: 'NEW_REACTION', articleId: reactionArticleId, reaction: addedReaction });
                    console.log('Server: Broadcasted NEW_REACTION.');
                    break;
                case 'GET_ALL_ARTICLES': // Client can still request all articles
                    console.log('Server: Processing GET_ALL_ARTICLES request (on message)...');
                    const articles = await getAllArticles();
                    console.log(`Server: Found ${articles.length} articles to send for GET_ALL_ARTICLES message.`);
                    ws.send(JSON.stringify({ type: 'ALL_ARTICLES', articles: articles }));
                    console.log('Server: Sent ALL_ARTICLES in response to GET_ALL_ARTICLES message.');
                    break;
                case 'GET_ALL_CATEGORIES': // New message type for fetching categories
                    console.log('Server: Processing GET_ALL_CATEGORIES request...');
                    const categories = await getAllCategories();
                    console.log(`Server: Found ${categories.length} categories to send.`);
                    ws.send(JSON.stringify({ type: 'ALL_CATEGORIES', categories: categories }));
                    console.log('Server: Sent ALL_CATEGORIES.');
                    break;
                default:
                    console.warn('Unknown message type:', data.type);
            }
        } catch (error) {
            console.error('Error processing message:', error);
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
