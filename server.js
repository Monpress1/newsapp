const WebSocket = require('ws');
const http = require('http'); // Required for creating an HTTP server (even if just for WS)
const fs = require('fs'); // For file system operations, if you want to persist data
const path = require('path'); // For path manipulation

// --- Data Storage (In-memory for simplicity - Use a database in production!) ---
let articles = [];
let categories = [
    { id: 1, name: "General" },
    { id: 2, name: "Politics" },
    { id: 3, name: "Technology" },
    { id: 4, name: "Sports" },
    { id: 5, name: "Business" },
    { id: 6, name: "Entertainment" },
    { id: 7, name: "Health" }
];

// File to persist data (optional, for basic persistence)
const DATA_FILE = path.join(__dirname, 'data.json');

// Load data from file on server start
function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        articles = data.articles || [];
        categories = data.categories || [ // Re-initialize default categories if not present
            { id: 1, name: "General" },
            { id: 2, name: "Politics" },
            { id: 3, name: "Technology" },
            { id: 4, name: "Sports" },
            { id: 5, name: "Business" },
            { id: 6, name: "Entertainment" },
            { id: 7, name: "Health" }
        ];
        console.log('Data loaded from data.json');
    } else {
        console.log('No data.json found. Starting with empty articles and default categories.');
        // Initial save if file doesn't exist
        saveData();
    }
}

// Save data to file
function saveData() {
    const data = { articles, categories };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    console.log('Data saved to data.json');
}

// Ensure unique IDs
function generateUniqueId(collection) {
    if (collection.length === 0) return 1;
    return Math.max(...collection.map(item => item.id)) + 1;
}

// Helper to find category by ID
function findCategoryById(categoryId) {
    return categories.find(cat => cat.id === categoryId) || null;
}

// --- WebSocket Server Setup ---

// Create a simple HTTP server to allow WebSocket server to listen
const server = http.createServer((req, res) => {
    // This server can also serve static files if needed, but for now, it's minimal
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('WebSocket server is running.');
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

// Create WebSocket server attached to the HTTP server
const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
    console.log('Client connected');

    // Send initial data to the newly connected client
    // Ensure all articles and their comments have valid timestamps before sending
    const initialArticles = articles.map(article => ({
        ...article,
        timestamp: article.timestamp || Date.now(), // Ensure timestamp exists
        comments: (article.comments || []).map(comment => ({
            ...comment,
            timestamp: comment.timestamp || Date.now() // Ensure comment timestamp exists
        }))
    }));

    ws.send(JSON.stringify({
        type: 'INITIAL_DATA',
        articles: initialArticles,
        categories: categories
    }));

    ws.on('message', message => {
        try {
            const data = JSON.parse(message);
            console.log('Received:', data.type, data);

            switch (data.type) {
                case 'PUBLISH_ARTICLE':
                    const newArticle = {
                        id: generateUniqueId(articles),
                        title: data.article.title,
                        content: data.article.content,
                        imageUrl: data.article.imageUrl || '', // Default to empty string if no image
                        timestamp: Date.now(), // *** IMPORTANT: Add timestamp here ***
                        categoryId: data.article.categoryId,
                        // Attach the full category object based on the ID for client display
                        category: findCategoryById(data.article.categoryId),
                        comments: [],
                        reactions: []
                    };
                    articles.push(newArticle);
                    saveData(); // Save data after adding new article

                    // Broadcast new article to all connected clients
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({ type: 'NEW_ARTICLE', article: newArticle }));
                        }
                    });
                    break;

                case 'POST_COMMENT':
                    const articleIdForComment = data.articleId;
                    const commentData = data.comment;
                    const articleToComment = articles.find(a => a.id === articleIdForComment);

                    if (articleToComment) {
                        if (!articleToComment.comments) {
                            articleToComment.comments = [];
                        }
                        const newComment = {
                            id: generateUniqueId(articleToComment.comments),
                            userName: commentData.userName || 'Anonymous',
                            commentText: commentData.commentText,
                            timestamp: Date.now() // *** IMPORTANT: Add timestamp here ***
                        };
                        articleToComment.comments.push(newComment);
                        saveData(); // Save data after adding new comment

                        // Broadcast new comment to all connected clients
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({ type: 'NEW_COMMENT', articleId: articleIdForComment, comment: newComment }));
                            }
                        });
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Article not found for comment.' }));
                    }
                    break;

                case 'POST_REACTION':
                    const articleIdForReaction = data.articleId;
                    const reactionData = data.reaction;
                    const articleToReact = articles.find(a => a.id === articleIdForReaction);

                    if (articleToReact) {
                        if (!articleToReact.reactions) {
                            articleToReact.reactions = [];
                        }
                        // Check if this client ID already reacted with this type to prevent multiple identical reactions from same user
                        const existingReactionIndex = articleToReact.reactions.findIndex(
                            r => r.clientId === reactionData.clientId && r.type === reactionData.type
                        );

                        if (existingReactionIndex === -1) {
                            const newReaction = {
                                type: reactionData.type,
                                clientId: reactionData.clientId,
                                timestamp: Date.now()
                            };
                            articleToReact.reactions.push(newReaction);
                            saveData(); // Save data after adding new reaction

                            // Broadcast new reaction to all connected clients
                            wss.clients.forEach(client => {
                                if (client.readyState === WebSocket.OPEN) {
                                    client.send(JSON.stringify({ type: 'NEW_REACTION', articleId: articleIdForReaction, reaction: newReaction }));
                                }
                            });
                        } else {
                            // Optionally, send an error back to the specific client if they already reacted
                            ws.send(JSON.stringify({ type: 'ERROR', message: 'You already reacted with this type.' }));
                        }
                    } else {
                        ws.send(JSON.stringify({ type: 'ERROR', message: 'Article not found for reaction.' }));
                    }
                    break;

                // You can add more message types as needed, e.g., 'GET_ALL_ARTICLES', 'GET_CATEGORIES'
                // For simplicity, 'INITIAL_DATA' handles initial sync.
                default:
                    ws.send(JSON.stringify({ type: 'ERROR', message: 'Unknown message type.' }));
                    break;
            }
        } catch (error) {
            console.error('Error parsing message or processing request:', error);
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid message format or server error.' }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    ws.on('error', error => {
        console.error('WebSocket error:', error);
    });
});

// Load data initially when server starts
loadData();

// Start the HTTP server (and thus the WebSocket server)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(`WebSocket server running on ws://localhost:${PORT}`);
});

