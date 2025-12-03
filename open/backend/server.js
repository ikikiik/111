// ============================
// WePlay Backend + Socket.io + KBO AiScore API (최종 통합 버전)
// ============================

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const axios = require("axios");
const cheerio = require("cheerio");

const http = require("http");
const { Server } = require("socket.io");

const app = express();
const PORT = process.env.PORT || 4000;

// ============================
// 미들웨어
// ============================
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// ============================
// 업로드 디렉토리 / multer 설정
// ============================
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext);
    cb(null, `${Date.now()}-${base}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.use("/uploads", express.static(uploadDir));


// ============================
// MySQL Pool
// ============================
const db = mysql
  .createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT),
    waitForConnections: true,
    connectionLimit: 10,
  })
  .promise();


// ============================
// Socket.io (채팅)
// ============================
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const chatHistory = [];
const MAX_CHAT_HISTORY = 100;

io.on("connection", (socket) => {
  console.log("🔥 채팅 연결:", socket.id);

  socket.on("chat:message", (msg) => {
    const message = {
      text: msg.text,
      nickname: msg.nickname || "익명",
      timestamp: msg.timestamp || Date.now(),
    };

    chatHistory.push(message);
    if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();

    io.emit("chat:message", message);
  });

  socket.on("disconnect", () => {
    console.log("❌ 채팅 종료:", socket.id);
  });
});


// ============================
// Health check
// ============================
app.get("/", (req, res) => {
  res.send("WePlay Backend Running OK + KBO API Ready");
});

app.get("/api/chat/history", (req, res) => {
  res.json(chatHistory.slice(-MAX_CHAT_HISTORY));
});


// ========================================================================
// 🎯 KBO 경기 API (AiScore 기반 완전 안정 버전)
// ========================================================================

// 날짜 YYYY-MM-DD 변환
function normalizeDate(dateParam) {
  if (!dateParam) {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return dateParam;
}

// AiScore HTML 전체 텍스트에서 KBO 경기 기록 추출
async function fetchRawKboFromAiScore() {
  try {
    const url =
      "https://m.aiscore.com/baseball/tournament-kbo/2jr7onc64gs1q0e";

    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    const $ = cheerio.load(res.data);
    const text = $("body").text();

    const lines = text
      .split("\n")
      .map((v) => v.trim())
      .filter((v) => v.length > 0);

    const regex =
      /^(\d{4})\/(\d{2})\/(\d{2})\s+(.+?)\s+(.+?)\s+(\d+)\s+(\d+)$/;

    const games = [];

    for (const line of lines) {
      const m = line.match(regex);
      if (!m) continue;

      const [_, y, mm, dd, t1, t2, s1, s2] = m;

      games.push({
        date: `${y}-${mm}-${dd}`,
        team1: t1,
        team2: t2,
        score1: Number(s1),
        score2: Number(s2),
      });
    }

    return games;
  } catch (err) {
    console.error("❌ AiScore 크롤링 실패:", err);
    return [];
  }
}

// 프론트 형식으로 변환
async function fetchKboNormalized(dateParam, monthParam) {
  const raw = await fetchRawKboFromAiScore();

  let data = raw;
  if (dateParam) {
    const d = normalizeDate(dateParam);
    data = data.filter((g) => g.date === d);
  } else if (monthParam) {
    data = data.filter((g) => g.date.startsWith(monthParam));
  }

  return data.map((g) => ({
    date: g.date,
    time: "",
    home: g.team1,
    away: g.team2,
    score: `${g.score1} - ${g.score2}`,
    status: "종료",
    league: "KBO",
  }));
}

// 프론트에서 사용하는 기본 엔드포인트
app.get("/api/games/kbo/naver", async (req, res) => {
  try {
    const { date, month } = req.query;
    const games = await fetchKboNormalized(date, month);
    res.json(games);
  } catch (err) {
    res.json([]);
  }
});

// 원본 AiScore
app.get("/api/games/kbo/aiscore", async (req, res) => {
  try {
    const data = await fetchRawKboFromAiScore();
    res.json({ games: data });
  } catch (err) {
    res.json({ games: [] });
  }
});


// ========================================================================
// 회원가입 / 로그인
// ========================================================================
app.post("/api/register", async (req, res) => {
  const { username, password, nickname } = req.body;
  if (!username || !password || !nickname)
    return res.status(400).json({ message: "필수 값 누락" });

  try {
    const [exist] = await db.query(
      "SELECT id FROM users WHERE username = ?",
      [username]
    );
    if (exist.length)
      return res.status(409).json({ message: "이미 존재하는 아이디" });

    await db.query(
      "INSERT INTO users (username, password, nickname) VALUES (?, ?, ?)",
      [username, password, nickname]
    );

    res.json({ message: "회원가입 완료" });
  } catch (err) {
    console.error("회원가입 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ message: "아이디/비번 입력" });

  try {
    const [rows] = await db.query(
      "SELECT * FROM users WHERE username = ? AND password = ?",
      [username, password]
    );
    if (!rows.length)
      return res.status(401).json({ message: "아이디 또는 비밀번호 오류" });

    const user = rows[0];
    res.json({
      message: "로그인 성공",
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
      },
    });
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});

// GET /api/user
app.get("/api/user", async (req, res) => {
  const { username } = req.query;
  if (!username)
    return res.status(400).json({ message: "username 누락" });

  try {
    const [rows] = await db.query(
      "SELECT id, username, nickname, profile_image, intro FROM users WHERE username = ?",
      [username]
    );
    if (!rows.length)
      return res.status(404).json({ message: "유저 없음" });

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});


// ========================================================================
// 게시글 CRUD
// ========================================================================
app.get("/api/posts", async (req, res) => {
  const { sort } = req.query;

  let orderBy = "created_at DESC";
  if (sort === "popular") orderBy = "likes DESC, created_at DESC";

  try {
    const [rows] = await db.query(
      `SELECT id, title, writer, likes, views, created_at
       FROM posts ORDER BY ${orderBy}`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});

app.get("/api/posts/:id", async (req, res) => {
  const id = req.params.id;

  try {
    const [rows] = await db.query("SELECT * FROM posts WHERE id = ?", [id]);
    if (!rows.length)
      return res.status(404).json({ message: "게시글 없음" });

    await db.query("UPDATE posts SET views = views + 1 WHERE id = ?", [id]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});

app.post("/api/posts", upload.single("image"), async (req, res) => {
  const { title, content, writer, password } = req.body;
  if (!title || !content || !writer || !password)
    return res.status(400).json({ message: "필수 입력 누락" });

  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

  try {
    const [result] = await db.query(
      "INSERT INTO posts (title, content, writer, password, image_url) VALUES (?, ?, ?, ?, ?)",
      [title, content, writer, password, imageUrl]
    );

    res.json({
      id: result.insertId,
      message: "게시글 등록 완료",
    });
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});

app.put("/api/posts/:id", async (req, res) => {
  const id = req.params.id;
  const { title, content, password } = req.body;

  if (!title || !content || !password)
    return res.status(400).json({ message: "필수 입력 누락" });

  try {
    const [rows] = await db.query(
      "SELECT * FROM posts WHERE id = ? AND password = ?",
      [id, password]
    );
    if (!rows.length)
      return res
        .status(403)
        .json({ message: "비밀번호 불일치" });

    await db.query(
      "UPDATE posts SET title = ?, content = ? WHERE id = ?",
      [title, content, id]
    );

    res.json({ message: "수정 완료" });
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});

app.delete("/api/posts/:id", async (req, res) => {
  const id = req.params.id;
  const { password } = req.body;

  if (!password)
    return res.status(400).json({ message: "비밀번호 입력" });

  try {
    const [rows] = await db.query(
      "SELECT * FROM posts WHERE id = ? AND password = ?",
      [id, password]
    );
    if (!rows.length)
      return res
        .status(403)
        .json({ message: "비밀번호 불일치" });

    await db.query("DELETE FROM posts WHERE id = ?", [id]);
    res.json({ message: "삭제 완료" });
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});

// 좋아요
app.post("/api/posts/:id/like", async (req, res) => {
  const postId = req.params.id;
  const { username } = req.body;

  if (!username)
    return res.status(400).json({ message: "username 필요" });

  try {
    const [u] = await db.query(
      "SELECT id FROM users WHERE username = ?",
      [username]
    );
    if (!u.length)
      return res.status(404).json({ message: "유저 없음" });

    const userId = u[0].id;

    const [exist] = await db.query(
      "SELECT * FROM post_likes WHERE post_id = ? AND user_id = ?",
      [postId, userId]
    );
    if (exist.length) {
      const [[post]] = await db.query(
        "SELECT likes FROM posts WHERE id = ?",
        [postId]
      );
      return res.json({
        liked: true,
        likes: post.likes,
        message: "이미 좋아요 함",
      });
    }

    await db.query(
      "INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)",
      [postId, userId]
    );
    await db.query("UPDATE posts SET likes = likes + 1 WHERE id = ?", [
      postId,
    ]);

    const [[post]] = await db.query(
      "SELECT likes FROM posts WHERE id = ?",
      [postId]
    );

    res.json({
      liked: true,
      likes: post.likes,
      message: "좋아요 반영됨",
    });
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});

// ========================================================================
// 댓글
// ========================================================================
app.get("/api/comments/:postId", async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, post_id, parent_id, writer, content, created_at
       FROM comments
       WHERE post_id = ?
       ORDER BY created_at ASC`,
      [req.params.postId]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});

app.post("/api/comments", async (req, res) => {
  const { postId, parentId, writer, content } = req.body;

  if (!postId || !writer || !content)
    return res.status(400).json({ message: "필수 값 누락" });

  try {
    const [result] = await db.query(
      "INSERT INTO comments (post_id, parent_id, writer, content) VALUES (?, ?, ?, ?)",
      [postId, parentId || null, writer, content]
    );

    res.json({
      id: result.insertId,
      message: "댓글 등록 완료",
    });
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});

app.delete("/api/comments/:id", async (req, res) => {
  try {
    await db.query(
      "DELETE FROM comments WHERE id = ? OR parent_id = ?",
      [req.params.id, req.params.id]
    );

    res.json({ message: "삭제 완료" });
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});


// ========================================================================
// 마이페이지
// ========================================================================
app.get("/api/mypage/posts", async (req, res) => {
  const { username } = req.query;

  if (!username)
    return res.status(400).json({ message: "username 누락" });

  try {
    const [rows] = await db.query(
      "SELECT * FROM posts WHERE writer = ? ORDER BY created_at DESC",
      [username]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});

app.get("/api/mypage/liked", async (req, res) => {
  const { username } = req.query;

  if (!username)
    return res.status(400).json({ message: "username 누락" });

  try {
    const [rows] = await db.query(
      `SELECT p.*
       FROM post_likes pl
       JOIN users u ON pl.user_id = u.id
       JOIN posts p ON p.id = pl.post_id
       WHERE u.username = ?
       ORDER BY pl.created_at DESC`,
      [username]
    );

    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});

app.post("/api/user/profile", async (req, res) => {
  const { username, profileImage, intro } = req.body;

  if (!username)
    return res.status(400).json({ message: "username 누락" });

  try {
    await db.query(
      "UPDATE users SET profile_image = ?, intro = ? WHERE username = ?",
      [profileImage || null, intro || "", username]
    );

    res.json({ message: "프로필 수정 완료" });
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});

app.post("/api/user/change-password", async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;

  if (!username || !oldPassword || !newPassword)
    return res.status(400).json({ message: "필수 값 누락" });

  try {
    const [rows] = await db.query(
      "SELECT * FROM users WHERE username = ? AND password = ?",
      [username, oldPassword]
    );
    if (!rows.length)
      return res.status(400).json({ message: "현재 비밀번호 불일치" });

    await db.query(
      "UPDATE users SET password = ? WHERE username = ?",
      [newPassword, username]
    );

    res.json({ message: "비밀번호 변경 완료" });
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});

app.post("/api/user/delete", async (req, res) => {
  const { username } = req.body;

  if (!username)
    return res.status(400).json({ message: "username 누락" });

  try {
    await db.query("DELETE FROM users WHERE username = ?", [username]);
    res.json({ message: "회원 탈퇴 완료" });
  } catch (err) {
    res.status(500).json({ message: "서버 오류" });
  }
});


// ============================
// 서버 실행
// ============================
server.listen(PORT, () => {
  console.log(`🚀 WePlay Backend + Socket.io Running on port ${PORT}`);
});
