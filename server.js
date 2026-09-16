const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

const app = express();

const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// BASE URL
// --------------------------------------------------
// Local testing:
// http://localhost:3000
//
// If using ngrok, change this to your ngrok URL.
const BASE_URL =
    process.env.BASE_URL || "https://rescuer-rigid-mollusk.ngrok-free.dev";

// --------------------------------------------------
// Middleware
// --------------------------------------------------

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --------------------------------------------------
// Data storage
// --------------------------------------------------

const dataDirectory = path.join(__dirname, "data");
const dataFile = path.join(dataDirectory, "visitors.json");

// Create data folder if it doesn't exist
if (!fs.existsSync(dataDirectory)) {
    fs.mkdirSync(dataDirectory, { recursive: true });
}

// Create visitors.json if it doesn't exist
if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, "[]", "utf8");
}

// Read visitors
function getVisitors() {
    try {
        const data = fs.readFileSync(dataFile, "utf8");

        if (!data.trim()) {
            return [];
        }

        return JSON.parse(data);
    } catch (error) {
        console.error("Error reading visitors.json:", error);
        return [];
    }
}

// Save visitors
function saveVisitors(visitors) {
    fs.writeFileSync(
        dataFile,
        JSON.stringify(visitors, null, 2),
        "utf8"
    );
}

// --------------------------------------------------
// WhatsApp
// --------------------------------------------------

let whatsappReady = false;

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "mining-training"
    }),
    puppeteer: {
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox"
        ]
    }
});

// QR Code
client.on("qr", (qr) => {
    console.log("\n======================================");
    console.log("SCAN THIS QR CODE WITH WHATSAPP");
    console.log("======================================\n");

    qrcode.generate(qr, {
        small: true
    });
});

// WhatsApp ready
client.on("ready", () => {
    whatsappReady = true;

    console.log("\n======================================");
    console.log("WhatsApp Client is READY");
    console.log("======================================\n");
});

// Authentication failure
client.on("auth_failure", (message) => {
    whatsappReady = false;

    console.error("WhatsApp authentication failed:", message);
});

// Disconnected
client.on("disconnected", (reason) => {
    whatsappReady = false;

    console.log("WhatsApp disconnected:", reason);
});

// Initialize WhatsApp
client.initialize();

// --------------------------------------------------
// Utility functions
// --------------------------------------------------

// Normalize Indian phone number
function normalizePhone(phone) {
    return String(phone)
        .replace(/\D/g, "")
        .replace(/^0+/, "");
}

// Send WhatsApp message
async function sendWhatsAppMessage(phone, message) {

    if (!whatsappReady) {
        throw new Error(
            "WhatsApp is not connected. Please scan the QR code and wait until WhatsApp Client is READY."
        );
    }

    const normalizedPhone = normalizePhone(phone);

    if (!normalizedPhone) {
        throw new Error("Invalid phone number.");
    }

    const chatId = `${normalizedPhone}@c.us`;

    await client.sendMessage(chatId, message);
}

// --------------------------------------------------
// Route: Admin Dashboard
// --------------------------------------------------

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "public", "admin.html")
    );
});

// --------------------------------------------------
// Route: Get all visitors
// --------------------------------------------------

app.get("/api/visitors", (req, res) => {

    const visitors = getVisitors();

    // Latest visitor first
    visitors.sort(
        (a, b) =>
            new Date(b.created_at) -
            new Date(a.created_at)
    );

    res.json({
        success: true,
        visitors
    });
});

// --------------------------------------------------
// Route: Add visitor + send training link
// --------------------------------------------------

app.post("/api/add-visitor", async (req, res) => {

    const {
        name,
        phone,
        address,
        purpose
    } = req.body;

    // Validation
    if (!name || !phone || !address || !purpose) {
        return res.status(400).json({
            success: false,
            message: "All fields are required."
        });
    }

    const normalizedPhone = normalizePhone(phone);

    if (normalizedPhone.length < 10) {
        return res.status(400).json({
            success: false,
            message: "Please enter a valid phone number."
        });
    }

    // Generate unique training ID
    const id = crypto.randomUUID();

    const createdAt = new Date().toISOString();

    const visitor = {
        id: id,
        name: name.trim(),
        phone: normalizedPhone,
        address: address.trim(),
        purpose: purpose.trim(),

        status: "Pending",

        created_at: createdAt,
        completed_at: null,

        link_sent: false
    };

    // Save visitor first
    const visitors = getVisitors();

    visitors.push(visitor);

    saveVisitors(visitors);

    // Training link
    const watchLink =
        `${BASE_URL}/watch.html?id=${encodeURIComponent(id)}`;

    const message =
`Hello ${visitor.name},

Please click the link below to complete your safety training video:

${watchLink}

Please watch the complete video.

Once you finish the video, your training completion will be automatically recorded.

Thank you.`;

    // Send WhatsApp
    try {

        await sendWhatsAppMessage(
            normalizedPhone,
            message
        );

        // Update link sent status
        const updatedVisitors = getVisitors();

        const savedVisitor = updatedVisitors.find(
            item => item.id === id
        );

        if (savedVisitor) {
            savedVisitor.link_sent = true;
        }

        saveVisitors(updatedVisitors);

        return res.json({
            success: true,
            message: "Visitor saved and training link sent successfully.",
            visitor: savedVisitor
        });

    } catch (error) {

        console.error(
            "WhatsApp sending error:",
            error
        );

        return res.status(500).json({
            success: false,
            message:
                "Visitor was saved, but WhatsApp message could not be sent.",
            error: error.message,
            visitorId: id
        });
    }
});

// --------------------------------------------------
// Route: Video completed
// --------------------------------------------------

app.post("/api/video-completed", async (req, res) => {

    const { id } = req.body;

    if (!id) {
        return res.status(400).json({
            success: false,
            message: "Training ID is missing."
        });
    }

    const visitors = getVisitors();

    const visitor = visitors.find(
        item => item.id === id
    );

    if (!visitor) {
        return res.status(404).json({
            success: false,
            message: "Training record not found."
        });
    }

    // Prevent duplicate completion
    if (visitor.status !== "Completed") {

        visitor.status = "Completed";

        // Server-side timestamp
        visitor.completed_at =
            new Date().toISOString();

        saveVisitors(visitors);
    }

    // Send confirmation WhatsApp
    let confirmationSent = false;

    try {

        const confirmationMessage =
`Congratulations ${visitor.name}!

You have successfully completed your training video.

Training Status: COMPLETED

Thank you.`;

        await sendWhatsAppMessage(
            visitor.phone,
            confirmationMessage
        );

        confirmationSent = true;

    } catch (error) {

        console.error(
            "Confirmation WhatsApp error:",
            error.message
        );
    }

    res.json({
        success: true,
        message: "Training completion recorded.",
        confirmationSent: confirmationSent,
        completedAt: visitor.completed_at
    });
});

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, () => {

    console.log("\n======================================");
    console.log("Mining Training Server Started");
    console.log(`Server: http://localhost:${PORT}`);
    console.log(`Training Base URL: ${BASE_URL}`);
    console.log("======================================\n");

});