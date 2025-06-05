require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const session = require("express-session");
const bcrypt = require("bcrypt");
const path = require("path");
const multer = require("multer");

const app = express();
const port = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Middleware
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "school-calendar-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
  }),
);

// Serve static files
app.use(express.static("public"));

// Initialize database tables
async function initDatabase() {
  try {
    console.log("Initializing database...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS date_configs (
        date_key DATE PRIMARY KEY,
        color VARCHAR(7),
        day_type VARCHAR(1) CHECK (day_type IN ('A', 'B')),
        is_access BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        date_key DATE NOT NULL,
        title VARCHAR(255) NOT NULL,
        time TIME NOT NULL,
        department VARCHAR(50) NOT NULL,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_materials (
        id SERIAL PRIMARY KEY,
        date_key DATE NOT NULL,
        grade VARCHAR(4) NOT NULL,
        title VARCHAR(255) NOT NULL,
        link TEXT NOT NULL,
        type VARCHAR(20) DEFAULT 'lesson',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS date_descriptions (
        date_key DATE PRIMARY KEY,
        description TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("✅ Database tables initialized successfully");
  } catch (err) {
    console.error("❌ Error initializing database:", err);
  }
}

// Admin middleware
const requireAdmin = (req, res, next) => {
  if (req.session.isAdmin) {
    next();
  } else {
    res.status(401).json({ error: "Admin access required" });
  }
};

// Routes

// Admin login
app.post("/api/admin/login", async (req, res) => {
  const { password } = req.body;

  if (password === "Lions") {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid password" });
  }
});

// Admin logout
app.post("/api/admin/logout", (req, res) => {
  req.session.isAdmin = false;
  res.json({ success: true });
});

// Check admin status
app.get("/api/admin/status", (req, res) => {
  res.json({ isAdmin: !!req.session.isAdmin });
});

// Date Configurations
app.get("/api/date-configs", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM date_configs");
    const configs = {};
    result.rows.forEach((row) => {
      configs[row.date_key.toISOString().split("T")[0]] = {
        color: row.color,
        dayType: row.day_type,
        isAccess: row.is_access,
      };
    });
    res.json(configs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/date-configs", requireAdmin, async (req, res) => {
  const { dateKey, config } = req.body;

  try {
    await pool.query(
      `
      INSERT INTO date_configs (date_key, color, day_type, is_access, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT (date_key)
      DO UPDATE SET
        color = COALESCE($2, date_configs.color),
        day_type = COALESCE($3, date_configs.day_type),
        is_access = COALESCE($4, date_configs.is_access),
        updated_at = CURRENT_TIMESTAMP
    `,
      [
        dateKey,
        config.color || null,
        config.dayType || null,
        config.isAccess || false,
      ],
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Events
app.get("/api/events", async (req, res) => {
  const { startDate, endDate, department } = req.query;

  try {
    let query = "SELECT * FROM events WHERE date_key >= $1 AND date_key <= $2";
    let params = [startDate, endDate];

    if (department && department !== "See All") {
      query += " AND department = $3";
      params.push(department);
    }

    query += " ORDER BY date_key, time";

    const result = await pool.query(query, params);

    const eventsByDate = {};
    result.rows.forEach((event) => {
      const dateKey = event.date_key.toISOString().split("T")[0];
      if (!eventsByDate[dateKey]) {
        eventsByDate[dateKey] = [];
      }
      eventsByDate[dateKey].push({
        id: event.id,
        title: event.title,
        time: event.time.slice(0, 5),
        department: event.department,
        description: event.description,
      });
    });

    res.json(eventsByDate);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/events", async (req, res) => {
  const { dateKey, title, time, department, description } = req.body;

  try {
    const result = await pool.query(
      `
      INSERT INTO events (date_key, title, time, department, description)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `,
      [dateKey, title, time, department, description || null],
    );

    const event = result.rows[0];
    res.json({
      id: event.id,
      title: event.title,
      time: event.time.slice(0, 5),
      department: event.department,
      description: event.description,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/events/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query("DELETE FROM events WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Daily Materials
app.get("/api/materials", async (req, res) => {
  const { dateKey } = req.query;

  try {
    const result = await pool.query(
      `
      SELECT * FROM daily_materials 
      WHERE date_key = $1 
      ORDER BY grade, created_at
    `,
      [dateKey],
    );

    const materialsByGrade = {};
    result.rows.forEach((material) => {
      if (!materialsByGrade[material.grade]) {
        materialsByGrade[material.grade] = [];
      }
      materialsByGrade[material.grade].push({
        id: material.id,
        title: material.title,
        link: material.link,
        type: material.type,
      });
    });

    res.json(materialsByGrade);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/materials", requireAdmin, async (req, res) => {
  const { dateKey, grade, title, link, type } = req.body;

  try {
    const result = await pool.query(
      `
      INSERT INTO daily_materials (date_key, grade, title, link, type)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `,
      [dateKey, grade, title, link, type || "lesson"],
    );

    const material = result.rows[0];
    res.json({
      id: material.id,
      title: material.title,
      link: material.link,
      type: material.type,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/materials/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query("DELETE FROM daily_materials WHERE id = $1", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Date Descriptions
app.get("/api/descriptions", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM date_descriptions");
    const descriptions = {};
    result.rows.forEach((row) => {
      descriptions[row.date_key.toISOString().split("T")[0]] = row.description;
    });
    res.json(descriptions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/descriptions", requireAdmin, async (req, res) => {
  const { dateKey, description } = req.body;

  try {
    await pool.query(
      `
      INSERT INTO date_descriptions (date_key, description, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      ON CONFLICT (date_key)
      DO UPDATE SET
        description = $2,
        updated_at = CURRENT_TIMESTAMP
    `,
      [dateKey, description],
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// Health check
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (err) {
    res.status(500).json({ status: "error", database: "disconnected" });
  }
});

// Serve the main app
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start server
async function startServer() {
  await initDatabase();
  app.listen(port, "0.0.0.0", () => {
    console.log(`🚀 Server running on port ${port}`);
    console.log(`🌐 Open http://localhost:${port} to view the app`);
  });
}

startServer();
