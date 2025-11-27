// ============================
// NAVER SPORTS HTML 크롤링 + 기존 기능 통합 server.js (완전체)
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
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================
// 업로드 디렉토리 생성
// ============================
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });
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
// Socket.io
// ============================
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

io.on("connection", (socket) => {
  console.log("채팅 연결됨:", socket.id);

  socket.on("chat:message", (msg) => {
    io.emit("chat:message", msg);
  });

  socket.on("disconnect", () => {
    console.log("채팅 종료:", socket.id);
  });
});

// ============================
// 기본 라우트
// ============================
app.get("/", (req, res) => {
  res.send("Backend Running + NAVER HTML Crawler READY");
});

// =====================================================================
// 🎯 NAVER SPORTS HTML 크롤링 함수
// =====================================================================

async function crawlNaverKBO_HTML(dateStr) {
  const url = `https://m.sports.naver.com/kbaseball/schedule/index?date=${dateStr}`;

  const res = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1",
    },
  });

  const $ = cheerio.load(res.data);

  const results = [];

  // 네이버 모바일 HTML의 KBO 경기 목록 선택자
  $(".schedule_list").each((_, el) => {
    const time = $(el).find(".time").text().trim();

    const home = $(el).find(".home .name").text().trim();
    const away = $(el).find(".away .name").text().trim();

    const homeScore = $(el).find(".home .score").text().trim();
    const awayScore = $(el).find(".away .score").text().trim();

    let score = "";
    let status = "예정";

    if (homeScore && awayScore) {
      score = `${homeScore} - ${awayScore}`;
      status = "종료";
    }

    results.push({
      date: dateStr,
      time,
      home,
      away,
      score,
      status,
      league: "KBO",
    });
  });

  return results;
}

// =====================================================================
// 🎯 API 엔드포인트: 네이버 HTML 크롤러
// =====================================================================

app.get("/api/games/kbo/html", async (req, res) => {
  const date = req.query.date;
  if (!date)
    return res.status(400).json({ message: "date=YYYY-MM-DD 필요" });

  try {
    const games = await crawlNaverKBO_HTML(date);
    res.json(games);
  } catch (err) {
    console.error("NAVER HTML 크롤링 오류:", err);
    res.status(500).json({ message: "HTML 크롤링 실패" });
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
      "SELECT id FROM users WHERE username = ?", [username]
    );
    if (exist.length)
      return res.status(409).json({ message: "이미 존재하는 아이디" });

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

  try {
    const [rows] = await db.query(
      "SELECT * FROM users WHERE username = ?", [username]
    );
    if (!rows.length)
      return res.status(401).json({ message: "존재하지 않는 아이디" });

    if (rows[0].password !== password)
      return res.status(401).json({ message: "비밀번호 오류" });

    res.json({
      message: "로그인 성공",
      user: {
        id: rows[0].id,
        username: rows[0].username,
        nickname: rows[0].nickname,
      }
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
    const [rows] = await db.query("SELECT * FROM posts ORDER BY id DESC");
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

    res.json({ message: "등록 완료", postId: result.insertId });
  } catch (err) {
    console.error("게시글 등록 오류:", err);
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
    console.error("댓글 불러오기 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

app.post("/api/comments", async (req, res) => {
  const { postId, writer, content, password, parentId } = req.body;

  try {
    await db.query(
      "INSERT INTO comments (post_id, writer, content, password, parent_id) VALUES (?, ?, ?, ?, ?)",
      [postId, writer, content, password, parentId || null]
    );
    res.json({ message: "댓글 작성 완료" });
  } catch (err) {
    console.error("댓글 작성 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// =====================================================================
// 마이페이지
// =====================================================================

app.get("/api/user/info", async (req, res) => {
  const { username } = req.query;
  try {
    const [rows] = await db.query(
      "SELECT * FROM users WHERE username = ?", [username]
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

  try {
    const [rows] = await db.query(
      "SELECT * FROM users WHERE username=? AND password=?",
      [username, oldPassword]
    );
    if (!rows.length)
      return res.status(400).json({ message: "현재 비밀번호 오류" });

    await db.query(
      "UPDATE users SET password=? WHERE username=?",
      [newPassword, username]
    );

    res.json({ message: "비밀번호 변경 완료" });
  } catch (err) {
    console.error("비밀번호 변경 오류:", err);
    res.status(500).json({ message: "서버 에러" });
  }
});

// =====================================================================
// 서버 시작
// =====================================================================

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT} + NAVER HTML Crawler ACTIVE`);
});
