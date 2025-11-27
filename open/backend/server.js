// ============================
// YB Sports Backend + Socket.io + NAVER KBO API (전체 통합본)
// ============================

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const axios = require("axios");         // ★ 네이버 API용
const cheerio = require("cheerio");     // 필요 없지만 혹시 몰라 유지

// Socket.io
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------------
// 기본 미들웨어
// ----------------------------
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----------------------------
// 이미지 업로드 설정
// ----------------------------
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

// ----------------------------
// MySQL 연결 (pool + promise)
// ----------------------------
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

// ----------------------------
// 서버 상태 테스트
// ----------------------------
app.get("/", (req, res) => {
  res.send("Backend Running + NAVER KBO API Ready!");
});

// ----------------------------
// Socket.io 설정
// ----------------------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log("🔥 채팅 연결:", socket.id);

  socket.on("chat:message", (msg) => {
    io.emit("chat:message", msg); // 전체 broadcast
  });

  socket.on("disconnect", () => {
    console.log("❌ 채팅 종료:", socket.id);
  });
});

// =====================================================================
// 🎯 NAVER SPORTS KBO API (핵심 크롤링/JSON 변환)
// =====================================================================
// 모바일 네이버 JSON API:
// https://m.sports.naver.com/api/sports/kbo/schedule?date=YYYY-MM-DD
// =====================================================================

async function fetchNaverKBO(dateStr) {
  const url = `https://m.sports.naver.com/api/sports/kbo/schedule?date=${dateStr}`;

  const res = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1",
    },
  });

  const data = res.data;
  if (!data || !data.games) return [];

  return data.games.map((g) => ({
    date: dateStr,
    time: g.time || "",
    home: g.homeTeam?.name || "",
    away: g.awayTeam?.name || "",
    score:
      g.status === "END"
        ? `${g.homeTeam.score} - ${g.awayTeam.score}`
        : "",
    status:
      g.status === "BEFORE"
        ? "예정"
        : g.status === "END"
        ? "종료"
        : g.status || "",
    league: "KBO",
  }));
}

// ★ 네이버 KBO 경기 일정 엔드포인트
// GET /api/games/kbo/naver?date=2025-11-27
app.get("/api/games/kbo/naver", async (req, res) => {
  try {
    const date = req.query.date;

    if (!date)
      return res.status(400).json({ message: "date=YYYY-MM-DD 필요" });

    const games = await fetchNaverKBO(date);
    return res.json(games);
  } catch (err) {
    console.error("NAVER KBO API 오류:", err);
    return res.status(500).json({ message: "네이버 경기 데이터를 불러올 수 없음" });
  }
});

// =====================================================================
// 회원가입 / 로그인
// =====================================================================

app.post("/api/register", async (req, res) => {
  const { username, password, nickname } = req.body;

  if (!username || !password || !nickname)
    return res.status(400).json({ message: "필수 값 누락" });

  try {
    const [exist] = await db.query(
      "SELECT id FROM users WHERE username = ?",
      [username]
    );
    if (exist.length) return res.status(409).json({ message: "이미 존재하는 아이디" });

    await db.query(
      "INSERT INTO users (username, password, nickname) VALUES (?, ?, ?)",
      [username, password, nickname]
    );

    res.status(201).json({ message: "회원가입 완료" });
  } catch (err) {
    console.error("회원가입 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ message: "아이디/비밀번호 필요" });

  try {
    const [rows] = await db.query(
      "SELECT id, username, password, nickname FROM users WHERE username = ?",
      [username]
    );

    if (!rows.length)
      return res.status(401).json({ message: "존재하지 않는 아이디" });

    const user = rows[0];
    if (user.password !== password)
      return res.status(401).json({ message: "비밀번호 불일치" });

    res.json({
      message: "로그인 성공",
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
      },
    });
  } catch (err) {
    console.error("로그인 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// =====================================================================
// 게시글 CRUD
// =====================================================================

app.get("/api/posts", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM posts ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("게시글 목록 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

app.post("/api/posts", upload.single("image"), async (req, res) => {
  const { title, content, writer, password } = req.body;

  if (!title || !content || !writer || !password)
    return res.status(400).json({ message: "필수 값 누락" });

  const imageUrl = req.file
    ? `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`
    : null;

  try {
    const [result] = await db.query(
      "INSERT INTO posts (title, content, writer, password, image_url) VALUES (?, ?, ?, ?, ?)",
      [title, content, writer, password, imageUrl]
    );

    res.status(201).json({ message: "게시글 등록됨", postId: result.insertId });
  } catch (err) {
    console.error("게시글 작성 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

app.get("/api/posts/popular", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM posts ORDER BY likes DESC, views DESC LIMIT 5"
    );
    res.json(rows);
  } catch (err) {
    console.error("인기글 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

app.get("/api/posts/:id", async (req, res) => {
  const id = req.params.id;

  try {
    await db.query("UPDATE posts SET views = views + 1 WHERE id = ?", [id]);

    const [rows] = await db.query("SELECT * FROM posts WHERE id = ?", [id]);
    if (!rows.length)
      return res.status(404).json({ message: "게시글 없음" });

    res.json(rows[0]);
  } catch (err) {
    console.error("게시글 조회 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

app.put("/api/posts/:id", async (req, res) => {
  const { title, content, password } = req.body;
  const id = req.params.id;

  try {
    const [rows] = await db.query(
      "SELECT * FROM posts WHERE id = ?",
      [id]
    );

    if (!rows.length) return res.status(404).json({ message: "게시글 없음" });
    if (rows[0].password !== password)
      return res.status(403).json({ message: "비밀번호 불일치" });

    await db.query(
      "UPDATE posts SET title=?, content=? WHERE id = ?",
      [title, content, id]
    );

    res.json({ message: "수정 완료" });
  } catch (err) {
    console.error("게시글 수정 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

app.delete("/api/posts/:id", async (req, res) => {
  const { password } = req.body;
  const id = req.params.id;

  try {
    const [rows] = await db.query(
      "SELECT * FROM posts WHERE id = ?",
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: "게시글 없음" });
    if (rows[0].password !== password)
      return res.status(403).json({ message: "비밀번호 불일치" });

    await db.query("DELETE FROM posts WHERE id = ?", [id]);
    res.json({ message: "삭제 완료" });
  } catch (err) {
    console.error("삭제 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

app.post("/api/posts/:id/like", async (req, res) => {
  const id = req.params.id;

  try {
    await db.query("UPDATE posts SET likes = likes + 1 WHERE id = ?", [id]);
    const [rows] = await db.query("SELECT likes FROM posts WHERE id = ?", [id]);
    res.json({ likes: rows[0].likes });
  } catch (err) {
    console.error("좋아요 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// =====================================================================
// 댓글
// =====================================================================

app.get("/api/comments/:postId", async (req, res) => {
  const postId = req.params.postId;

  try {
    const [rows] = await db.query(
      "SELECT * FROM comments WHERE post_id = ? ORDER BY id ASC",
      [postId]
    );
    res.json(rows);
  } catch (err) {
    console.error("댓글 목록 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

app.post("/api/comments", async (req, res) => {
  const { postId, writer, content, password, parentId } = req.body;

  if (!postId || !writer || !content || !password)
    return res.status(400).json({ message: "필수 값 누락" });

  try {
    await db.query(
      "INSERT INTO comments (post_id, writer, content, password, parent_id) VALUES (?, ?, ?, ?, ?)",
      [postId, writer, content, password, parentId || null]
    );
    res.status(201).json({ message: "댓글 등록됨" });
  } catch (err) {
    console.error("댓글 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

app.delete("/api/comments/:id", async (req, res) => {
  const { password } = req.body;
  const id = req.params.id;

  try {
    const [rows] = await db.query(
      "SELECT * FROM comments WHERE id = ?",
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: "댓글 없음" });
    if (rows[0].password !== password)
      return res.status(403).json({ message: "비밀번호 불일치" });

    // 댓글 + 대댓글 삭제
    await db.query("DELETE FROM comments WHERE id = ? OR parent_id = ?", [
      id,
      id,
    ]);

    res.json({ message: "삭제 완료" });
  } catch (err) {
    console.error("댓글 삭제 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// =====================================================================
// 마이페이지
// =====================================================================

app.get("/api/user/info", async (req, res) => {
  const { username } = req.query;

  if (!username)
    return res.status(400).json({ message: "username 필요" });

  try {
    const [rows] = await db.query(
      "SELECT * FROM users WHERE username = ?",
      [username]
    );
    if (!rows.length)
      return res.status(404).json({ message: "유저 없음" });

    res.json(rows[0]);
  } catch (err) {
    console.error("유저 조회 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

app.put("/api/user/password", async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;

  if (!username || !oldPassword || !newPassword)
    return res.status(400).json({ message: "필수 값 누락" });

  try {
    const [rows] = await db.query(
      "SELECT * FROM users WHERE username=? AND password=?",
      [username, oldPassword]
    );
    if (!rows.length)
      return res.status(400).json({ message: "현재 비밀번호 불일치" });

    await db.query(
      "UPDATE users SET password=? WHERE username=?",
      [newPassword, username]
    );

    res.json({ message: "비밀번호 변경 완료" });
  } catch (err) {
    console.error("비밀번호 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

app.put("/api/user/profile", async (req, res) => {
  const { username, intro, profileImage } = req.body;

  if (!username)
    return res.status(400).json({ message: "username 필요" });

  try {
    await db.query(
      "UPDATE users SET intro=?, profile_image=? WHERE username=?",
      [intro || "", profileImage || null, username]
    );

    res.json({ message: "프로필 수정 완료" });
  } catch (err) {
    console.error("프로필 수정 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// =====================================================================
// 서버 실행
// =====================================================================
server.listen(PORT, () => {
  console.log(`🚀 Server + NAVER KBO API Running on port ${PORT}`);
});
