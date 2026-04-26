const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { MongoClient, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'mediashield_secret_key_2024';
const MONGO_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'mediashield';
const SHARE_LINK_EXPIRY_HOURS = parseInt(process.env.SHARE_LINK_EXPIRY_HOURS || '0', 10);

function getServerBaseUrl(req) {
    return process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
}
const USERS_COLLECTION = 'users';
const ASSETS_COLLECTION = 'assets';
const uploadsDir = path.join(__dirname, 'uploads');
const dataDir = path.join(__dirname, 'data');
const usersFile = path.join(dataDir, 'users.json');
const assetsFile = path.join(dataDir, 'assets.json');

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(usersFile)) {
    fs.writeFileSync(usersFile, '[]', 'utf8');
}
if (!fs.existsSync(assetsFile)) {
    fs.writeFileSync(assetsFile, '[]', 'utf8');
}

const readJsonFile = (file) => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
    } catch (err) {
        return [];
    }
};

const writeJsonFile = (file, data) => {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
};

const matchQuery = (item, query) => {
    return Object.entries(query).every(([key, value]) => {
        if (value && typeof value === 'object' && value._bsontype === 'ObjectID') {
            return item[key] && item[key].toString() === value.toString();
        }
        return item[key] === value;
    });
};

const localCollection = (file) => ({
    async findOne(query) {
        const records = readJsonFile(file);
        return records.find(item => matchQuery(item, query)) || null;
    },
    async insertOne(doc) {
        const records = readJsonFile(file);
        const newDoc = { ...doc, _id: doc._id || crypto.randomUUID() };
        records.push(newDoc);
        writeJsonFile(file, records);
        return { insertedId: newDoc._id };
    },
    async updateOne(filter, update) {
        const records = readJsonFile(file);
        let matchedCount = 0;
        const updated = records.map(item => {
            if (matchQuery(item, filter)) {
                matchedCount += 1;
                if (update.$set) {
                    return { ...item, ...update.$set };
                }
            }
            return item;
        });
        writeJsonFile(file, updated);
        return { matchedCount, modifiedCount: matchedCount };
    },
    async deleteOne(filter) {
        const records = readJsonFile(file);
        const remaining = records.filter(item => !matchQuery(item, filter));
        const deletedCount = records.length - remaining.length;
        writeJsonFile(file, remaining);
        return { deletedCount };
    },
    find(query) {
        let records = readJsonFile(file).filter(item => matchQuery(item, query));
        return {
            sort(sortObj) {
                const [field, order] = Object.entries(sortObj)[0] || [];
                records = records.sort((a, b) => {
                    if (a[field] === b[field]) return 0;
                    return a[field] > b[field] ? (order === -1 ? -1 : 1) : (order === -1 ? 1 : -1);
                });
                return this;
            },
            async toArray() {
                return records;
            }
        };
    },
    async createIndex() {
        return;
    }
});

let usersCollection;
let assetsCollection;
const useMongo = { value: false };

function parseId(id) {
    const stringId = (id || '').toString();
    if (useMongo.value && /^[0-9a-fA-F]{24}$/.test(stringId)) {
        return new ObjectId(stringId);
    }
    return stringId;
}

async function connectDatabase() {
    try {
        const client = new MongoClient(MONGO_URI, { useUnifiedTopology: true });
        await client.connect();
        const db = client.db(DB_NAME);
        usersCollection = db.collection(USERS_COLLECTION);
        assetsCollection = db.collection(ASSETS_COLLECTION);
        await usersCollection.createIndex({ email: 1 }, { unique: true });
        await assetsCollection.createIndex({ userId: 1 });
        useMongo.value = true;
        console.log('Connected to MongoDB:', MONGO_URI, 'DB:', DB_NAME);
    } catch (err) {
        console.warn('MongoDB unavailable, using local JSON storage fallback:', err.message);
        usersCollection = localCollection(usersFile);
        assetsCollection = localCollection(assetsFile);
        useMongo.value = false;
        console.log('Using local JSON file storage in', dataDir);
    }
}

const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname) || '';
        cb(null, `${crypto.randomUUID()}${ext}`);
    }
});
const upload = multer({ storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname)));

function getMediaMimeType(url) {
    const ext = path.extname(url || '').toLowerCase();
    switch (ext) {
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.gif': return 'image/gif';
        case '.webp': return 'image/webp';
        case '.svg': return 'image/svg+xml';
        case '.mp4': return 'video/mp4';
        case '.webm': return 'video/webm';
        case '.ogg': return 'video/ogg';
        case '.mov': return 'video/quicktime';
        case '.m4v': return 'video/mp4';
        default: return 'application/octet-stream';
    }
}

function isVideoUrl(url) {
    const ext = path.extname(url || '').toLowerCase();
    return ['.mp4', '.webm', '.ogg', '.mov', '.m4v', '.avi', '.mkv'].includes(ext);
}

function isImageUrl(url) {
    const ext = path.extname(url || '').toLowerCase();
    return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext);
}

function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: 'No authorization header' });
    }
    const token = authHeader.replace('Bearer ', '');
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        console.error('Invalid token:', err.message);
        res.status(401).json({ error: 'Invalid token' });
    }
}

function normalizeEmail(email) {
    return (email || '').toString().trim().toLowerCase();
}

function normalizePassword(password) {
    return (password || '').toString().trim();
}

app.post('/api/register', async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        const password = normalizePassword(req.body.password);
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password required' });
        }
        const existingUser = await usersCollection.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ message: 'User already exists' });
        }
        const hash = await bcrypt.hash(password, 10);
        const username = req.body.username ? req.body.username.toString().trim() : email.split('@')[0];
        const ownershipStatus = req.body.ownershipStatus ? req.body.ownershipStatus.toString() : 'Unverified';
        const result = await usersCollection.insertOne({ email, password: hash, username, ownershipStatus, createdAt: new Date() });
        const newUserId = result.insertedId;
        res.status(201).json({ message: 'Registration successful', id: newUserId });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ message: 'Email is already registered' });
        }
        console.error('Register error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        const password = normalizePassword(req.body.password);
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password required' });
        }
        const user = await usersCollection.findOne({ email });
        if (!user) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        const match = await bcrypt.compare(password, user.password);
        if (!match) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        const token = jwt.sign({ id: user._id.toString(), email: user.email, username: user.username, ownershipStatus: user.ownershipStatus }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ message: 'Login successful', token });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/change-password', verifyToken, async (req, res) => {
    try {
        const email = normalizeEmail(req.user.email);
        const oldPassword = normalizePassword(req.body.oldPassword);
        const newPassword = normalizePassword(req.body.newPassword);
        if (!oldPassword || !newPassword) {
            return res.status(400).json({ message: 'Old and new password are required' });
        }
        const user = await usersCollection.findOne({ email });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        const match = await bcrypt.compare(oldPassword, user.password);
        if (!match) {
            return res.status(401).json({ message: 'Invalid current password' });
        }
        const hash = await bcrypt.hash(newPassword, 10);
        await usersCollection.updateOne({ email }, { $set: { password: hash } });
        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        console.error('Change-password error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/profile', verifyToken, async (req, res) => {
    try {
        const userId = parseId(req.user.id);
        const user = await usersCollection.findOne({ _id: userId });
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json({ email: user.email, username: user.username, ownershipStatus: user.ownershipStatus || 'Unverified' });
    } catch (err) {
        console.error('Profile fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/profile/ownership', verifyToken, async (req, res) => {
    try {
        const userId = parseId(req.user.id);
        const ownershipStatus = (req.body.ownershipStatus || 'Unverified').toString();
        await usersCollection.updateOne({ _id: userId }, { $set: { ownershipStatus } });
        res.json({ email: req.user.email, username: req.user.username || req.user.email.split('@')[0], ownershipStatus });
    } catch (err) {
        console.error('Ownership update error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/assets', verifyToken, async (req, res) => {
    try {
        const userId = parseId(req.user.id);
        const assets = await assetsCollection.find({ userId }).sort({ createdAt: -1 }).toArray();
        res.json({ assets });
    } catch (err) {
        console.error('Fetch assets error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/assets', verifyToken, upload.single('file'), async (req, res) => {
    try {
        const userId = parseId(req.user.id);
        const email = req.user.email;
        const username = req.user.username || email.split('@')[0];
        const originalLink = req.body.originalLink || '';
        const name = req.body.name || (req.file ? req.file.originalname : originalLink || 'Protected Asset');
        const fileHash = req.body.fileHash || 'unknown';
        const isLink = String(req.body.isLink) === 'true';
        const linkType = req.body.linkType || (isLink ? 'link' : 'file');
        const txid = '0x' + Math.random().toString(16).substr(2, 8);
        const protectedAt = new Date();

        const assetDoc = {
            _id: crypto.randomUUID(),
            userId,
            email,
            username,
            name,
            txid,
            fileHash,
            originalLink,
            isLink,
            linkType,
            protectedAt,
            createdAt: new Date()
        };

        if (req.file) {
            assetDoc.filename = req.file.filename;
            assetDoc.fileUrl = `${getServerBaseUrl(req)}/uploads/${req.file.filename}`;
            assetDoc.originalLink = assetDoc.originalLink || assetDoc.fileUrl;
        }

        const result = await assetsCollection.insertOne(assetDoc);
        const assetId = result.insertedId || assetDoc._id;
        const protectedLink = `${getServerBaseUrl(req)}/view/${assetId}`;
        if (SHARE_LINK_EXPIRY_HOURS > 0) {
            assetDoc.shareExpiresAt = new Date(Date.now() + SHARE_LINK_EXPIRY_HOURS * 60 * 60 * 1000);
        }
        await assetsCollection.updateOne({ _id: parseId(assetId) }, { $set: { protectedLink, shareExpiresAt: assetDoc.shareExpiresAt } });
        const savedAsset = await assetsCollection.findOne({ _id: parseId(assetId) });
        res.status(201).json(savedAsset);
    } catch (err) {
        console.error('Save asset error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/assets/:id', verifyToken, async (req, res) => {
    try {
        const assetId = parseId(req.params.id);
        const userId = parseId(req.user.id);
        const asset = await assetsCollection.findOne({ _id: assetId, userId });
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }
        await assetsCollection.deleteOne({ _id: assetId });
        if (asset.filename) {
            const filePath = path.join(uploadsDir, asset.filename);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        }
        res.json({ message: 'Asset deleted successfully' });
    } catch (err) {
        console.error('Delete asset error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/stats', verifyToken, async (req, res) => {
    try {
        const userId = parseId(req.user.id);
        const assets = await assetsCollection.find({ userId }).toArray();
        res.json({
            totalAssets: assets.length,
            avgVerifyTime: '0.42s',
            nodes: 184
        });
    } catch (err) {
        console.error('Stats fetch error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/share/:id', verifyToken, async (req, res) => {
    try {
        const assetId = parseId(req.params.id);
        const asset = await assetsCollection.findOne({ _id: assetId });
        if (!asset) {
            return res.status(404).json({ message: 'Asset not found' });
        }
        res.json({ shareUrl: `${getServerBaseUrl(req)}/view/${asset._id}`, name: asset.name, description: `Secure MediaShield asset: ${asset.name}` });
    } catch (err) {
        console.error('Share link error:', err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/assets/share/:id', async (req, res) => {
    try {
        const assetId = parseId(req.params.id);
        const asset = await assetsCollection.findOne({ _id: assetId });
        if (!asset) {
            return res.status(404).send('Asset not found');
        }
        if (asset.fileUrl) {
            return res.redirect(asset.fileUrl);
        }
        if (asset.originalLink) {
            return res.redirect(asset.originalLink);
        }
        return res.status(404).send('No media available for this asset');
    } catch (err) {
        console.error('Share redirect error:', err);
        res.status(500).send('Unable to find shareable asset');
    }
});

app.get('/view/:id', async (req, res) => {
    try {
        const id = req.params.id;
        let asset = await assetsCollection.findOne({ _id: parseId(id) });
        if (!asset) {
            asset = await assetsCollection.findOne({ txid: id });
        }
        if (!asset) {
            return res.status(404).send('Asset not found');
        }

        if (asset.shareExpiresAt && new Date(asset.shareExpiresAt) < new Date()) {
            return res.status(410).send('This shared link has expired.');
        }

        const baseUrl = getServerBaseUrl(req);
        const mediaUrl = asset.fileUrl || asset.originalLink || `${baseUrl}/uploads/${asset.filename || ''}`;
        const mediaType = getMediaMimeType(mediaUrl);
        const pageUrl = `${baseUrl}/view/${encodeURIComponent(id)}`;
        const title = asset.name || 'MediaShield Secure Asset';
        const description = `Secure media asset from MediaShield. File: ${asset.name || asset.txid}`;

        const isVideo = isVideoUrl(mediaUrl);
        const isImage = isImageUrl(mediaUrl);
        const previewHtml = isVideo
            ? `<video controls autoplay muted playsinline style="max-width:100%; border-radius:18px; box-shadow:0 12px 40px rgba(0,0,0,0.5);">
                    <source src="${mediaUrl}" type="${mediaType}">
                    Your browser does not support video playback.
               </video>`
            : isImage
            ? `<img src="${mediaUrl}" alt="${title}" style="max-width:100%; border-radius:18px; box-shadow:0 12px 40px rgba(0,0,0,0.5);" />`
            : `<a href="${mediaUrl}" target="_blank" rel="noopener noreferrer" style="color:#00eaff;">Open secured media</a>`;

        const extraMeta = isVideo ? `
  <meta property="og:video" content="${mediaUrl}" />
  <meta property="og:video:secure_url" content="${mediaUrl}" />
  <meta property="og:video:type" content="${mediaType}" />
  <meta property="og:video:width" content="1280" />
  <meta property="og:video:height" content="720" />
  <meta name="twitter:card" content="player" />
  <meta name="twitter:player" content="${pageUrl}" />
  <meta name="twitter:player:width" content="1280" />
  <meta name="twitter:player:height" content="720" />
` : '';

        const ogType = isVideo ? 'video.other' : isImage ? 'image' : 'website';
        const twitterCard = isVideo ? 'player' : 'summary_large_image';
        const extraImageMeta = isImage ? `  <meta property="og:image" content="${mediaUrl}" />
  <meta property="og:image:secure_url" content="${mediaUrl}" />
  <meta property="og:image:type" content="${mediaType}" />
  <meta property="og:image:alt" content="${title}" />
  <link rel="image_src" href="${mediaUrl}" />
` : '';

        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <meta property="og:title" content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url" content="${pageUrl}" />
  <meta property="og:type" content="${ogType}" />
  ${extraImageMeta}
  <meta name="twitter:card" content="${twitterCard}" />
  <meta name="twitter:title" content="${title}" />
  <meta name="twitter:description" content="${description}" />
  <meta name="twitter:image" content="${mediaUrl}" />
  ${extraMeta}
  <style>
    body { margin:0; padding:0; font-family: Arial, sans-serif; background:#020617; color:#fff; display:flex; min-height:100vh; align-items:center; justify-content:center; text-align:center; }
    .preview { max-width:720px; padding:24px; }
    h1 { margin: 24px 0 12px; color:#00eaff; }
    p { margin:0 0 16px; color:#c2f7ff; }
    .details { color:#8fd8ff; font-size:0.95rem; margin-bottom:18px; }
    a { color:#00eaff; text-decoration:none; word-break:break-word; }
  </style>
</head>
<body>
  <div class="preview">
    ${previewHtml}
    <h1>${title}</h1>
    <p class="details">${description}</p>
    <p><a href="${mediaUrl}" target="_blank" rel="noopener noreferrer">Open secured asset</a></p>
  </div>
</body>
</html>`);
    } catch (err) {
        console.error('Preview page error:', err);
        res.status(500).send('Unable to render preview page.');
    }
});

app.get('/api/status', (req, res) => {
    const baseUrl = getServerBaseUrl(req);
    res.json({ message: 'Server is running', timestamp: new Date(), baseUrl });
});

app.get('/config.json', (req, res) => {
    const baseUrl = getServerBaseUrl(req);
    res.json({ baseUrl, apiBase: `${baseUrl}/api` });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'frontend.html'));
});

app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

connectDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`MediaShield Server started on http://localhost:${PORT}`);
        });
    })
    .catch(err => {
        console.error('Failed to connect to MongoDB:', err);
        process.exit(1);
    });