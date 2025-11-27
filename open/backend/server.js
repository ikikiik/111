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

const http = require("http");
const { Server } = require("socket.io");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================
// 기본 미들웨어
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

io.on("connection", (socket) => {
  console.log("🔥 채팅 연결:", socket.id);

  socket.on("chat:message", (msg) => {
    io.emit("chat:message", msg);
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

// ========================================================================
// 🎯 NAVER KBO 일정 API (games endpoint 사용)
//   https://m.sports.naver.com/api/sports/baseball/games
// ========================================================================

async function fetchNaverSchedule(dateStr) {
  // dateStr: "YYYY-MM-DD"
  const url =
    "https://m.sports.naver.com/api/sports/baseball/games" +
    "?fields=basic%2Cschedule%2Cbaseball%2Cmanual" +
    `&fromDate=${dateStr}&toDate=${dateStr}`;

  const res = await axios.get(url, {
    headers: {
      // 모바일 UA로 위장 (네이버가 모바일 전용일 때 대비)
      "User-Agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1",
    },
  });

  const data = res.data;

  if (!data || !data.games) return [];

  // KBO리그만 필터링해서 우리 포맷으로 변환
  return data.games
    .filter(
      (g) =>
        g?.schedule?.league?.name === "KBO리그" ||
        g?.basic?.leagueName === "KBO리그"
    )
    .map((g) => {
      const homeName =
        g.baseball?.homeTeam?.name ||
        g.schedule?.homeTeam?.name ||
        g.basic?.homeTeamName ||
        "";
      const awayName =
        g.baseball?.awayTeam?.name ||
        g.schedule?.awayTeam?.name ||
        g.basic?.awayTeamName ||
        "";

      const homeScore = g.baseball?.homeTeam?.score;
      const awayScore = g.baseball?.awayTeam?.score;

      let score = "";
      if (homeScore != null && awayScore != null) {
        score = `${homeScore} - ${awayScore}`;
      }

      let status = "예정";
      const t = g.status?.type || g.basic?.status;
      if (t === "END" || t === "RESULT") status = "종료";
      else if (t === "LIVE") status = "경기중";

      const startTime =
        g.schedule?.startTime || g.basic?.startTime || "";

      return {
        date: dateStr,
        time: startTime,
        home: homeName,
        away: awayName,
        score,
        status,
        league: "KBO",
      };
    });
}

// GET /api/games/kbo/naver?date=YYYY-MM-DD
app.get("/api/games/kbo/naver", async (req, res) => {
  const date = req.query.date;
  if (!date)
    return res.status(400).json({ message: "date=YYYY-MM-DD 필요" });

  try {
    const games = await fetchNaverSchedule(date);
    res.json(games);
  } catch (err) {
    console.error("네이버 KBO 일정 API 오류:", err?.response?.data || err);
    res.status(500).json({ message: "네이버 경기 정보를 불러올 수 없습니다." });
  }
});

// ========================================================================
// 회원가입 / 로그인
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

    res.status(201).json({ message: "회원가입 완료" });
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
      "SELECT * FROM users WHERE username = ?",
      [username]
    );

    if (rows.length === 0)
      return res.status(401).json({ message: "존재하지 않는 아이디입니다." });

    const user = rows[0];

    if (user.password !== password)
      return res.status(401).json({ message: "비밀번호가 올바르지 않습니다." });

    res.json({
      message: "로그인 성공",
      user: {
        id: user.id,
        username: user.username,
        nickname: user.nickname,
        intro: user.intro || "",
        profile_image: user.profile_image || null,
      },
    });
  } catch (err) {
    console.error("로그인 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// ========================================================================
// 게시글 CRUD
// ========================================================================

// GET /api/posts
app.get("/api/posts", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM posts ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("게시글 목록 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// GET /api/posts/popular - 인기글 (좋아요/조회수 기준 상위 5개)
app.get("/api/posts/popular", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT * FROM posts ORDER BY likes DESC, views DESC LIMIT 5"
    );
    res.json(rows);
  } catch (err) {
    console.error("인기글 조회 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// POST /api/posts  (이미지 포함 글쓰기)
app.post("/api/posts", upload.single("image"), async (req, res) => {
  const { title, content, writer, password } = req.body;

  if (!title || !content || !writer || !password) {
    return res.status(400).json({ message: "필수 값이 누락되었습니다." });
  }

  const imageUrl = req.file
    ? `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`
    : null;

  try {
    const [result] = await db.query(
      "INSERT INTO posts (title, content, writer, password, image_url) VALUES (?, ?, ?, ?, ?)",
      [title, content, writer, password, imageUrl]
    );

    res.status(201).json({
      message: "게시글이 등록되었습니다.",
      postId: result.insertId,
    });
  } catch (err) {
    console.error("게시글 등록 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// GET /api/posts/:id
app.get("/api/posts/:id", async (req, res) => {
  const id = req.params.id;

  try {
    // 조회수 증가
    await db.query("UPDATE posts SET views = views + 1 WHERE id = ?", [id]);

    const [rows] = await db.query("SELECT * FROM posts WHERE id = ?", [id]);
    if (!rows.length)
      return res.status(404).json({ message: "게시글이 존재하지 않습니다." });

    res.json(rows[0]);
  } catch (err) {
    console.error("게시글 조회 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// PUT /api/posts/:id
app.put("/api/posts/:id", async (req, res) => {
  const id = req.params.id;
  const { title, content, password } = req.body;

  if (!title || !content || !password) {
    return res.status(400).json({ message: "필수 값이 누락되었습니다." });
  }

  try {
    const [rows] = await db.query(
      "SELECT * FROM posts WHERE id = ?",
      [id]
    );
    if (!rows.length)
      return res.status(404).json({ message: "게시글이 존재하지 않습니다." });

    const post = rows[0];
    if (post.password !== password)
      return res.status(403).json({ message: "비밀번호가 일치하지 않습니다." });

    await db.query(
      "UPDATE posts SET title=?, content=? WHERE id=?",
      [title, content, id]
    );

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

  try {
    const [rows] = await db.query(
      "SELECT * FROM posts WHERE id = ?",
      [id]
    );
    if (!rows.length)
      return res.status(404).json({ message: "게시글이 존재하지 않습니다." });

    const post = rows[0];
    if (post.password !== password)
      return res.status(403).json({ message: "비밀번호가 일치하지 않습니다." });

    await db.query("DELETE FROM posts WHERE id = ?", [id]);
    res.json({ message: "게시글이 삭제되었습니다." });
  } catch (err) {
    console.error("게시글 삭제 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// POST /api/posts/:id/like
app.post("/api/posts/:id/like", async (req, res) => {
  const id = req.params.id;

  try {
    await db.query("UPDATE posts SET likes = likes + 1 WHERE id = ?", [id]);
    const [rows] = await db.query(
      "SELECT likes FROM posts WHERE id = ?",
      [id]
    );
    res.json({ likes: rows[0].likes });
  } catch (err) {
    console.error("좋아요 오류:", err);
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
      "SELECT * FROM comments WHERE post_id = ? ORDER BY id ASC",
      [postId]
    );
    res.json(rows);
  } catch (err) {
    console.error("댓글 목록 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// POST /api/comments
app.post("/api/comments", async (req, res) => {
  const { postId, writer, content, password, parentId } = req.body;

  if (!postId || !writer || !content || !password) {
    return res.status(400).json({ message: "필수 값이 누락되었습니다." });
  }

  try {
    await db.query(
      "INSERT INTO comments (post_id, writer, content, password, parent_id) VALUES (?, ?, ?, ?, ?)",
      [postId, writer, content, password, parentId || null]
    );

    res.status(201).json({ message: "댓글이 등록되었습니다." });
  } catch (err) {
    console.error("댓글 등록 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// DELETE /api/comments/:id
app.delete("/api/comments/:id", async (req, res) => {
  const id = req.params.id;
  const { password } = req.body;

  try {
    const [rows] = await db.query(
      "SELECT * FROM comments WHERE id = ?",
      [id]
    );
    if (!rows.length)
      return res.status(404).json({ message: "댓글이 존재하지 않습니다." });

    const comment = rows[0];
    if (comment.password !== password)
      return res.status(403).json({ message: "비밀번호가 일치하지 않습니다." });

    // 자기 자신 + 대댓글 같이 삭제
    await db.query("DELETE FROM comments WHERE id = ? OR parent_id = ?", [
      id,
      id,
    ]);

    res.json({ message: "댓글이 삭제되었습니다." });
  } catch (err) {
    console.error("댓글 삭제 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// ========================================================================
// 마이페이지 (유저 정보 / 비밀번호 변경 / 프로필 수정)
// ========================================================================

// GET /api/user/info?username=...
app.get("/api/user/info", async (req, res) => {
  const { username } = req.query;
  if (!username)
    return res.status(400).json({ message: "username이 필요합니다." });

  try {
    const [rows] = await db.query(
      "SELECT * FROM users WHERE username = ?",
      [username]
    );
    if (!rows.length)
      return res.status(404).json({ message: "유저가 존재하지 않습니다." });

    res.json(rows[0]);
  } catch (err) {
    console.error("유저 정보 조회 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// PUT /api/user/password
app.put("/api/user/password", async (req, res) => {
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
      return res.status(400).json({ message: "현재 비밀번호가 일치하지 않습니다." });

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

// PUT /api/user/profile
app.put("/api/user/profile", async (req, res) => {
  const { username, intro, profileImage } = req.body;

  if (!username)
    return res.status(400).json({ message: "username이 필요합니다." });

  try {
    await db.query(
      "UPDATE users SET intro = ?, profile_image = ? WHERE username = ?",
      [intro || "", profileImage || null, username]
    );

    res.json({ message: "프로필 업데이트 완료" });
  } catch (err) {
    console.error("프로필 업데이트 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// ============================
// 서버 실행
// ============================
server.listen(PORT, () => {
  console.log(`🚀 Server + Socket.io + NAVER KBO Running on port ${PORT}`);
});
