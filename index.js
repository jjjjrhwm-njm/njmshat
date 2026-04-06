const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const admin = require("firebase-admin");
const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");

const app = express();
app.use(express.json());

let sock;
const SESSION_ID = process.env.SESSION_ID;
const FIREBASE_CONFIG = JSON.parse(process.env.FIREBASE_CONFIG);

// --- 1. إعداد Firebase ---
if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(FIREBASE_CONFIG) });
}
const db = admin.firestore();

// --- 2. استعادة الهوية (عشان ما تمسح QR) ---
async function restoreIdentity() {
    try {
        const authDir = './auth_info';
        if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
        const sessionDoc = await db.collection('session').doc(SESSION_ID).get();
        if (sessionDoc.exists) {
            fs.writeFileSync(path.join(authDir, 'creds.json'), JSON.stringify(sessionDoc.data()));
            console.log("✅ تم استعادة هوية الواتساب بنجاح");
            return true;
        }
    } catch (e) { console.log("❌ فشل استعادة الهوية"); }
    return false;
}

// --- 3. تشغيل الواتساب ---
async function startWhatsApp() {
    await restoreIdentity();
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: "silent" }),
        browser: [process.env.BROWSER_NAME, "Chrome", "1.0"]
    });

    sock.ev.on('creds.update', async () => {
        await saveCreds();
        const creds = JSON.parse(fs.readFileSync('./auth_info/creds.json', 'utf-8'));
        await db.collection('session').doc(SESSION_ID).set(creds, { merge: true });
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') console.log("🚀 نجم اليمن: الواتساب متصل الآن");
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? 
                lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            if (shouldReconnect) startWhatsApp();
        }
    });
}

// --- 4. الـ API الخاص بالتطبيق ---

// أ. إرسال الكود
app.get("/request-otp", async (req, res) => {
    const { phone, deviceId } = req.query;
    if (!phone) return res.status(400).send("أدخل الرقم");

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const cleanPhone = phone.replace(/\D/g, '');
    const jid = cleanPhone + "@s.whatsapp.net";

    try {
        await db.collection('pending_codes').doc(cleanPhone).set({
            otp, deviceId, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await sock.sendMessage(jid, { text: `🔐 كود تفعيل تطبيق *نجم اليمن* هو: *${otp}*` });
        res.status(200).send("OK");
    } catch (e) { res.status(500).send("ERROR"); }
});

// ب. التحقق من الكود وتخزين المستخدم
app.get("/verify-otp", async (req, res) => {
    const { phone, code, deviceId } = req.query;
    const cleanPhone = phone.replace(/\D/g, '');
    const docRef = db.collection('pending_codes').doc(cleanPhone);
    const snap = await docRef.get();

    if (snap.exists && snap.data().otp === code) {
        // تخزين الرقم في قاعدة البيانات الرسمية
        await db.collection('users').doc(cleanPhone).set({
            phone: cleanPhone,
            deviceId: deviceId,
            verifiedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        await docRef.delete();
        res.status(200).send("SUCCESS");
    } else {
        res.status(401).send("FAIL");
    }
});

app.listen(process.env.PORT || 10000, () => {
    startWhatsApp();
    console.log("📡 السيرفر يعمل");
});
