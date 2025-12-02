// ============================
// WePlay Backend + Socket.io + NAVER KBO games API
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
// Socket.io
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
    if (chatHistory.length > MAX_CHAT_HISTORY) {
      chatHistory.shift();
    }

    io.emit("chat:message", message);
  });

  socket.on("disconnect", () => {
    console.log("❌ 채팅 종료:", socket.id);
  });
});

// ============================
// 헬스체크
// ============================
app.get("/", (req, res) => {
  res.send("Backend Running + NAVER KBO games API READY");
});

app.get("/api/chat/history", (req, res) => {
  res.json(chatHistory.slice(-MAX_CHAT_HISTORY));
});

// ========================================================================
// ========================================================================
// 🎯 KBO 경기 API - AiScore 크롤링 기반 (프론트는 /naver 그대로 사용)
// ========================================================================

// 날짜 YYYY-MM-DD 형식으로 정규화
function normalizeDate(dateParam) {
  if (!dateParam) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return dateParam;
}

/**
 * AiScore KBO 토너먼트 페이지에서
 *  YYYY/MM/DD 팀1 팀2 점수1 점수2
 * 형태의 라인들을 긁어서 JS 객체 배열로 반환
 */
async function fetchRawKboFromAiScore() {
  const url =
    "https://m.aiscore.com/baseball/tournament-kbo/2jr7onc64gs1q0e";

  const htmlRes = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
    timeout: 8000,
  });

  const $ = cheerio.load(htmlRes.data);
  const bodyText = $("body").text();

  const lines = bodyText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // 예시: 2025/10/31 Hanwha Eagles LG Twins 1 4
  const re =
    /^(\d{4})\/(\d{2})\/(\d{2})\s+(.+?)\s+(.+?)\s+(\d+)\s+(\d+)$/;

  const games = [];

  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;

    const [
      _,
      year,
      mm,
      dd,
      team1,
      team2,
      score1,
      score2,
    ] = m;

    const dateStr = `${year}-${mm}-${dd}`;

    games.push({
      date: dateStr,
      year: Number(year),
      month: mm,
      day: dd,
      team1,
      team2,
      score1: Number(score1),
      score2: Number(score2),
    });
  }

  return games;
}

/**
 * 프론트에서 기대하는 형태로 변환:
 *  {
 *    date: "YYYY-MM-DD",
 *    time: "",              // AiScore에는 시간 정보가 없으니 일단 공백
 *    home: "팀1",
 *    away: "팀2",
 *    score: "1 - 4",
 *    status: "종료",
 *    league: "KBO"
 *  }
 */
async function fetchKboGamesNormalized(dateParam, monthParam) {
  const raw = await fetchRawKboFromAiScore();

  let games = raw;

  if (dateParam) {
    const d = normalizeDate(dateParam);
    games = games.filter((g) => g.date === d);
  } else if (monthParam) {
    // monthParam: "YYYY-MM"
    games = games.filter((g) => g.date.startsWith(monthParam));
  }

  return games.map((g) => ({
    date: g.date,
    time: "", // 시간 정보는 없어서 비워둠
    home: g.team1,
    away: g.team2,
    score: `${g.score1} - ${g.score2}`,
    status: "종료", // AiScore 결과 기준이니까 종료 처리
    league: "KBO",
  }));
}

// GET /api/games/kbo/naver?date=YYYY-MM-DD
//    → 기존 프론트 코드 그대로 사용 가능
app.get("/api/games/kbo/naver", async (req, res) => {
  try {
    const { date, month } = req.query;
    const games = await fetchKboGamesNormalized(date, month);
    res.json(games);
  } catch (err) {
    console.error("KBO AiScore 기반 경기 정보 오류:", err);
    res
      .status(500)
      .json({ message: "KBO 경기 정보를 가져오는데 실패했습니다." });
  }
});

// (옵션) 원본 AiScore 파싱 결과가 필요하면 이 엔드포인트 사용
// GET /api/games/kbo/aiscore?date=YYYY-MM-DD&month=YYYY-MM
app.get("/api/games/kbo/aiscore", async (req, res) => {
  try {
    const { date, month } = req.query;
    const raw = await fetchRawKboFromAiScore();

    let games = raw;
    if (date) {
      const d = normalizeDate(date);
      games = games.filter((g) => g.date === d);
    } else if (month) {
      games = games.filter((g) => g.date.startsWith(month));
    }

    res.json({ games });
  } catch (err) {
    console.error("KBO AiScore 크롤링 실패:", err);
    res
      .status(500)
      .json({ message: "KBO 경기 정보를 가져오는데 실패했습니다." });
  }
});

// 🎯 AiScore 기반 KBO 경기 결과 API
// ========================================================================
//
// GET /api/games/kbo/aiscore
//   ?date=YYYY-MM-DD   → 그 날짜 경기만
//   ?month=YYYY-MM     → 그 달 경기만
//
app.get("/api/games/kbo/aiscore", async (req, res) => {
  try {
    const { date, month } = req.query;

    // AiScore KBO 토너먼트 페이지 (모바일 버전)
    const url =
      "https://m.aiscore.com/baseball/tournament-kbo/2jr7onc64gs1q0e";

    const htmlRes = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      timeout: 8000,
    });

    const $ = cheerio.load(htmlRes.data);

    // body 전체 텍스트에서 "YYYY/MM/DD 팀 팀 점수 점수" 패턴만 뽑기
    const bodyText = $("body").text();
    const lines = bodyText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // 예시: 2025/10/31 Hanwha Eagles LG Twins 1 4
    const re =
      /^(\d{4})\/(\d{2})\/(\d{2})\s+(.+?)\s+(.+?)\s+(\d+)\s+(\d+)$/;

    let games = [];

    for (const line of lines) {
      const m = line.match(re);
      if (!m) continue;

      const [
        _,
        year,
        mm,
        dd,
        team1,
        team2,
        score1,
        score2,
      ] = m;

      const dateStr = `${year}-${mm}-${dd}`;

      games.push({
        date: dateStr,          // "2025-10-31"
        year: Number(year),
        month: mm,              // "10"
        day: dd,                // "31"
        // AiScore에서 어떤 쪽이 홈/원정인지는 구조에 따라 다를 수 있어서
        // 일단 team1/team2로 두고, 프론트에서 그대로 표시만 해도 됨.
        team1,
        team2,
        score1: Number(score1),
        score2: Number(score2),
      });
    }

    // 날짜/월 필터 적용
    if (date) {
      games = games.filter((g) => g.date === date);
    } else if (month) {
      games = games.filter((g) => g.date.startsWith(month));
    }

    res.json({ games });
  } catch (err) {
    console.error("KBO AiScore 크롤링 실패:", err);
    res
      .status(500)
      .json({ message: "KBO 경기 정보를 가져오는데 실패했습니다." });
  }
});


// ========================================================================
// 회원가입 / 로그인 / 사용자 정보
// ========================================================================

// POST /api/register
app.post("/api/register", async (req, res) => {
  const { username, password, nickname } = req.body;

  if (!username || !password || !nickname) {
    return res.status(400).json({ message: "필수 값이 누락되었습니다." });
  }

  try {
    const [exist] = await db.query(
      "SELECT id FROM users WHERE username = ?",
      [username]
    );
    if (exist.length) {
      return res.status(409).json({ message: "이미 존재하는 아이디입니다." });
    }

    await db.query(
      "INSERT INTO users (username, password, nickname) VALUES (?, ?, ?)",
      [username, password, nickname]
    );

    res.json({ message: "회원가입이 완료되었습니다." });
  } catch (err) {
    console.error("회원가입 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// POST /api/login
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res
      .status(400)
      .json({ message: "아이디와 비밀번호를 모두 입력해주세요." });
  }

  try {
    const [rows] = await db.query(
      "SELECT * FROM users WHERE username = ? AND password = ?",
      [username, password]
    );
    if (!rows.length) {
      return res
        .status(401)
        .json({ message: "아이디 또는 비밀번호가 올바르지 않습니다." });
    }

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
    console.error("로그인 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// GET /api/user?username=...
app.get("/api/user", async (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ message: "username이 누락되었습니다." });
  }

  try {
    const [rows] = await db.query(
      "SELECT id, username, nickname, profile_image, intro FROM users WHERE username = ?",
      [username]
    );
    if (!rows.length) {
      return res.status(404).json({ message: "유저를 찾을 수 없습니다." });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("유저 정보 조회 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// ========================================================================
// 게시글 CRUD
// ========================================================================

// GET /api/posts?sort=latest|popular
app.get("/api/posts", async (req, res) => {
  const { sort } = req.query;

  let orderBy = "created_at DESC";
  if (sort === "popular") {
    orderBy = "likes DESC, created_at DESC";
  }

  try {
    const [rows] = await db.query(
      `SELECT id, title, writer, likes, views, created_at
       FROM posts
       ORDER BY ${orderBy}`
    );
    res.json(rows);
  } catch (err) {
    console.error("게시글 목록 조회 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// GET /api/posts/:id
app.get("/api/posts/:id", async (req, res) => {
  const id = req.params.id;

  try {
    const [rows] = await db.query("SELECT * FROM posts WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ message: "게시글을 찾을 수 없습니다." });
    }

    // 조회수 증가
    await db.query("UPDATE posts SET views = views + 1 WHERE id = ?", [id]);

    res.json(rows[0]);
  } catch (err) {
    console.error("게시글 조회 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// POST /api/posts
app.post("/api/posts", upload.single("image"), async (req, res) => {
  const { title, content, writer, password } = req.body;

  if (!title || !content || !writer || !password) {
    return res
      .status(400)
      .json({ message: "제목, 내용, 작성자, 비밀번호를 모두 입력해주세요." });
  }

  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

  try {
    const [result] = await db.query(
      "INSERT INTO posts (title, content, writer, password, image_url) VALUES (?, ?, ?, ?, ?)",
      [title, content, writer, password, imageUrl]
    );

    res.json({
      id: result.insertId,
      message: "게시글이 등록되었습니다.",
    });
  } catch (err) {
    console.error("게시글 등록 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// PUT /api/posts/:id
app.put("/api/posts/:id", async (req, res) => {
  const id = req.params.id;
  const { title, content, password } = req.body;

  if (!title || !content || !password) {
    return res
      .status(400)
      .json({ message: "제목, 내용, 비밀번호를 모두 입력해주세요." });
  }

  try {
    const [rows] = await db.query(
      "SELECT * FROM posts WHERE id = ? AND password = ?",
      [id, password]
    );
    if (!rows.length) {
      return res
        .status(403)
        .json({ message: "비밀번호가 일치하지 않아 수정할 수 없습니다." });
    }

    await db.query("UPDATE posts SET title = ?, content = ? WHERE id = ?", [
      title,
      content,
      id,
    ]);

    res.json({ message: "게시글이 수정되었습니다." });
  } catch (err) {
    console.error("게시글 수정 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// DELETE /api/posts/:id
app.delete("/api/posts/:id", async (req, res) => {
  const id = req.params.id;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ message: "비밀번호를 입력해주세요." });
  }

  try {
    const [rows] = await db.query(
      "SELECT * FROM posts WHERE id = ? AND password = ?",
      [id, password]
    );
    if (!rows.length) {
      return res
        .status(403)
        .json({ message: "비밀번호가 일치하지 않아 삭제할 수 없습니다." });
    }

    await db.query("DELETE FROM posts WHERE id = ?", [id]);
    res.json({ message: "게시글이 삭제되었습니다." });
  } catch (err) {
    console.error("게시글 삭제 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// POST /api/posts/:id/like
app.post("/api/posts/:id/like", async (req, res) => {
  const postId = req.params.id;
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ message: "username이 필요합니다." });
  }

  try {
    // 유저 ID 조회
    const [userRows] = await db.query(
      "SELECT id FROM users WHERE username = ?",
      [username]
    );
    if (!userRows.length) {
      return res.status(404).json({ message: "유저가 존재하지 않습니다." });
    }
    const userId = userRows[0].id;

    // 이미 좋아요 했는지 확인
    const [likeRows] = await db.query(
      "SELECT id FROM post_likes WHERE user_id = ? AND post_id = ?",
      [userId, postId]
    );

    if (likeRows.length) {
      const [[post]] = await db.query(
        "SELECT likes FROM posts WHERE id = ?",
        [postId]
      );
      return res.json({
        message: "이미 좋아요를 누른 게시글입니다.",
        liked: true,
        likes: post ? post.likes : 0,
      });
    }

    // post_likes에 추가 + posts.likes 증가
    await db.query(
      "INSERT INTO post_likes (user_id, post_id) VALUES (?, ?)",
      [userId, postId]
    );
    await db.query("UPDATE posts SET likes = likes + 1 WHERE id = ?", [
      postId,
    ]);

    const [[post]] = await db.query(
      "SELECT likes FROM posts WHERE id = ?",
      [postId]
    );

    res.json({
      message: "좋아요가 반영되었습니다.",
      liked: true,
      likes: post ? post.likes : 0,
    });
  } catch (err) {
    console.error("좋아요 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// GET /api/posts/liked?username=...
// 특정 유저가 좋아요한 게시글 목록
app.get("/api/posts/liked", async (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ message: "username이 필요합니다." });
  }

  try {
    const [userRows] = await db.query(
      "SELECT id FROM users WHERE username = ?",
      [username]
    );
    if (!userRows.length) {
      return res.status(404).json({ message: "유저가 존재하지 않습니다." });
    }
    const userId = userRows[0].id;

    const [rows] = await db.query(
      `SELECT p.*
       FROM posts p
       JOIN post_likes pl ON pl.post_id = p.id
       WHERE pl.user_id = ?
       ORDER BY pl.created_at DESC
       LIMIT 50`,
      [userId]
    );

    res.json(rows);
  } catch (err) {
    console.error("좋아요 게시글 조회 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// ========================================================================
// 댓글 / 대댓글
// ========================================================================

// GET /api/comments/:postId
app.get("/api/comments/:postId", async (req, res) => {
  const postId = req.params.postId;

  try {
    const [rows] = await db.query(
      `SELECT id, post_id, parent_id, writer, content, created_at
       FROM comments
       WHERE post_id = ?
       ORDER BY created_at ASC`,
      [postId]
    );

    res.json(rows);
  } catch (err) {
    console.error("댓글 목록 조회 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// POST /api/comments
app.post("/api/comments", async (req, res) => {
  const { postId, parentId, writer, content } = req.body;

  if (!postId || !writer || !content) {
    return res
      .status(400)
      .json({ message: "postId, writer, content는 필수입니다." });
  }

  try {
    const [result] = await db.query(
      "INSERT INTO comments (post_id, parent_id, writer, content) VALUES (?, ?, ?, ?)",
      [postId, parentId || null, writer, content]
    );

    res.json({
      id: result.insertId,
      message: "댓글이 등록되었습니다.",
    });
  } catch (err) {
    console.error("댓글 등록 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// DELETE /api/comments/:id
app.delete("/api/comments/:id", async (req, res) => {
  const id = req.params.id;

  try {
    // 대댓글도 함께 삭제
    await db.query(
      "DELETE FROM comments WHERE id = ? OR parent_id = ?",
      [id, id]
    );

    res.json({ message: "댓글이 삭제되었습니다." });
  } catch (err) {
    console.error("댓글 삭제 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// ========================================================================
// 마이페이지: 내가 쓴 글 / 좋아요한 글 / 프로필
// ========================================================================

// GET /api/mypage/posts?username=...
app.get("/api/mypage/posts", async (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ message: "username 이 누락되었습니다." });
  }

  try {
    const [rows] = await db.query(
      "SELECT * FROM posts WHERE writer = ? ORDER BY created_at DESC",
      [username]
    );
    res.json(rows);
  } catch (err) {
    console.error("마이페이지 게시글 조회 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// GET /api/mypage/liked?username=...
app.get("/api/mypage/liked", async (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ message: "username 이 누락되었습니다." });
  }

  try {
    const [rows] = await db.query(
      `SELECT p.*
       FROM posts p
       JOIN post_likes pl ON p.id = pl.post_id
       JOIN users u ON pl.user_id = u.id
       WHERE u.username = ?
       ORDER BY pl.created_at DESC`,
      [username]
    );
    res.json(rows);
  } catch (err) {
    console.error("마이페이지 좋아요 게시글 조회 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// POST /api/user/profile (프로필 이미지 + 한줄소개)
app.post("/api/user/profile", async (req, res) => {
  const { username, profileImage, intro } = req.body;

  if (!username) {
    return res.status(400).json({ message: "username 이 누락되었습니다." });
  }

  try {
    await db.query(
      "UPDATE users SET profile_image = ?, intro = ? WHERE username = ?",
      [profileImage || null, intro || "", username]
    );

    res.json({ message: "프로필 업데이트 완료" });
  } catch (err) {
    console.error("프로필 업데이트 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// POST /api/user/change-password
app.post("/api/user/change-password", async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;

  if (!username || !oldPassword || !newPassword) {
    return res.status(400).json({ message: "필수 값이 누락되었습니다." });
  }

  try {
    const [rows] = await db.query(
      "SELECT * FROM users WHERE username = ? AND password = ?",
      [username, oldPassword]
    );
    if (!rows.length)
      return res
        .status(400)
        .json({ message: "현재 비밀번호가 일치하지 않습니다." });

    await db.query(
      "UPDATE users SET password = ? WHERE username = ?",
      [newPassword, username]
    );

    res.json({ message: "비밀번호가 변경되었습니다." });
  } catch (err) {
    console.error("비밀번호 변경 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// POST /api/user/delete (회원 탈퇴)
app.post("/api/user/delete", async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ message: "username 이 누락되었습니다." });
  }

  try {
    await db.query("DELETE FROM users WHERE username = ?", [username]);
    res.json({ message: "회원 탈퇴가 완료되었습니다." });
  } catch (err) {
    console.error("회원 탈퇴 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// ============================
// 서버 실행
// ============================
server.listen(PORT, () => {
  console.log(`🚀 Server + Socket.io + NAVER KBO Running on port ${PORT}`);
});
