// ============================
// YB Sports Backend + Socket.io (최종 안정 버전)
// ============================

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
// TheSportsDB KBO용 (외부 API)
const THESPORTSDB_API_KEY = process.env.TSDB_API_KEY || "3"; // 테스트 키
const KBO_LEAGUE_ID = 4830; // Korean KBO League ID


// 🔥 Socket.io용 모듈
const http = require("http");
const { Server } = require("socket.io");

// ----------------------------
// 기본 설정
// ----------------------------
const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: "*",
  })
);

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

app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ----------------------------
// MySQL 연결
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

// ============================
// 기본 라우트 테스트
// ============================
app.get("/", (req, res) => {
  res.send("YB Sports Backend Running + Socket.io Ready!");
});

// ============================
//  Socket.io 실시간 채팅
// ============================

// Express를 감싼 http 서버 생성
const server = http.createServer(app);

// Socket.io 서버
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  console.log("🔥 채팅 접속:", socket.id);

  socket.on("chat:message", (msg) => {
    // msg: { nickname, text, time }
    io.emit("chat:message", msg); // 전체 사용자에게 전송
  });

  socket.on("disconnect", () => {
    console.log("❌ 채팅 종료:", socket.id);
  });
});

// ============================
// 1. 회원가입 / 로그인
// ============================

// 회원가입
app.post("/api/register", async (req, res) => {
  const { username, password, nickname } = req.body;

  if (!username || !password || !nickname)
    return res.status(400).json({ message: "필수 값이 비어 있습니다." });

  try {
    const [exist] = await db.query(
      "SELECT id FROM users WHERE username = ?",
      [username]
    );

    if (exist.length > 0)
      return res.status(409).json({ message: "이미 존재하는 아이디입니다." });

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

// 로그인
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ message: "아이디와 비밀번호를 입력하세요." });

  try {
    const [rows] = await db.query(
      "SELECT id, username, password, nickname FROM users WHERE username = ?",
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
      },
    });
  } catch (err) {
    console.error("로그인 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// ============================
// 2. 게시글
// ============================

// 게시글 목록
app.get("/api/posts", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, title, content, writer, created_at, views, likes, image_url FROM posts ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("게시글 목록 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// 게시글 작성
app.post("/api/posts", upload.single("image"), async (req, res) => {
  const { title, content, writer, password } = req.body;

  if (!title || !content || !writer || !password)
    return res.status(400).json({ message: "필수 값이 비어 있습니다." });

  let imageUrl = null;
  if (req.file) {
    const host = req.get("host");
    const protocol = req.protocol;
    imageUrl = `${protocol}://${host}/uploads/${req.file.filename}`;
  }

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
    console.error("게시글 작성 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// 인기글
app.get("/api/posts/popular", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, title, writer, created_at, views, likes, image_url FROM posts ORDER BY likes DESC, views DESC LIMIT 5"
    );
    res.json(rows);
  } catch (err) {
    console.error("인기글 조회 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// 상세 + 조회수 증가
app.get("/api/posts/:id", async (req, res) => {
  const postId = req.params.id;

  try {
    await db.query("UPDATE posts SET views = views + 1 WHERE id = ?", [
      postId,
    ]);

    const [rows] = await db.query(
      "SELECT id, title, content, writer, created_at, views, likes, image_url FROM posts WHERE id = ?",
      [postId]
    );

    if (rows.length === 0)
      return res.status(404).json({ message: "게시글을 찾을 수 없습니다." });

    res.json(rows[0]);
  } catch (err) {
    console.error("게시글 상세 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// 수정
app.put("/api/posts/:id", async (req, res) => {
  const postId = req.params.id;
  const { title, content, password } = req.body;

  if (!title || !content || !password)
    return res.status(400).json({ message: "필수 값이 비어 있습니다." });

  try {
    const [rows] = await db.query(
      "SELECT id, password FROM posts WHERE id = ?",
      [postId]
    );

    if (rows.length === 0)
      return res.status(404).json({ message: "게시글을 찾을 수 없습니다." });

    const post = rows[0];
    if (post.password !== password)
      return res.status(403).json({ message: "비밀번호 불일치" });

    await db.query("UPDATE posts SET title = ?, content = ? WHERE id = ?", [
      title,
      content,
      postId,
    ]);

    res.json({ message: "게시글이 수정되었습니다." });
  } catch (err) {
    console.error("게시글 수정 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// 삭제
app.delete("/api/posts/:id", async (req, res) => {
  const postId = req.params.id;
  const { password } = req.body;

  if (!password)
    return res.status(400).json({ message: "비밀번호를 입력해주세요." });

  try {
    const [rows] = await db.query(
      "SELECT id, password FROM posts WHERE id = ?",
      [postId]
    );

    if (rows.length === 0)
      return res.status(404).json({ message: "게시글을 찾을 수 없습니다." });

    const post = rows[0];
    if (post.password !== password)
      return res.status(403).json({ message: "비밀번호가 일치하지 않습니다." });

    await db.query("DELETE FROM posts WHERE id = ?", [postId]);

    res.json({ message: "게시글이 삭제되었습니다." });
  } catch (err) {
    console.error("게시글 삭제 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// 좋아요
app.post("/api/posts/:id/like", async (req, res) => {
  const postId = req.params.id;

  try {
    await db.query("UPDATE posts SET likes = likes + 1 WHERE id = ?", [
      postId,
    ]);

    const [rows] = await db.query(
      "SELECT id, likes FROM posts WHERE id = ?",
      [postId]
    );

    res.json({ likes: rows[0].likes });
  } catch (err) {
    console.error("좋아요 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// ============================
// 3. 댓글
// ============================

// 댓글 목록
app.get("/api/comments/:postId", async (req, res) => {
  const postId = req.params.postId;

  try {
    const [rows] = await db.query(
      "SELECT id, post_id, parent_id, writer, content, created_at FROM comments WHERE post_id = ? ORDER BY id ASC",
      [postId]
    );

    res.json(rows);
  } catch (err) {
    console.error("댓글 목록 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// 댓글 작성
app.post("/api/comments", async (req, res) => {
  const { postId, writer, content, password, parentId } = req.body;

  if (!postId || !writer || !content || !password)
    return res.status(400).json({ message: "필수 값이 비어 있습니다." });

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

// 댓글 삭제
app.delete("/api/comments/:id", async (req, res) => {
  const commentId = req.params.id;
  const { password } = req.body;

  if (!password)
    return res.status(400).json({ message: "비밀번호를 입력해주세요." });

  try {
    const [rows] = await db.query(
      "SELECT id, password FROM comments WHERE id = ?",
      [commentId]
    );

    if (rows.length === 0)
      return res.status(404).json({ message: "댓글을 찾을 수 없습니다." });

    if (rows[0].password !== password)
      return res.status(403).json({ message: "비밀번호 불일치" });

    // 댓글 + 대댓글 삭제
    await db.query(
      "DELETE FROM comments WHERE id = ? OR parent_id = ?",
      [commentId, commentId]
    );

    res.json({ message: "댓글 삭제 완료" });
  } catch (err) {
    console.error("댓글 삭제 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// ============================
// 4. 경기 정보
// ============================

app.get("/api/games", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, home_team, away_team, game_date, status, score FROM games ORDER BY game_date DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("경기 목록 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// 경기 추가
app.post("/api/games", async (req, res) => {
  const { home_team, away_team, game_date, status, score } = req.body;

  if (!home_team || !away_team || !game_date)
    return res.status(400).json({ message: "필수 값 부족" });

  try {
    const [result] = await db.query(
      "INSERT INTO games (home_team, away_team, game_date, status, score) VALUES (?, ?, ?, ?, ?)",
      [home_team, away_team, game_date, status || "", score || ""]
    );
    res.json({ gameId: result.insertId });
  } catch (err) {
    console.error("경기 추가 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// ===== KBO 실제 경기 정보 (TheSportsDB에서 바로 가져오기) =====
app.get("/api/games/kbo/upcoming", async (req, res) => {
  try {
    const url = `https://www.thesportsdb.com/api/v1/json/${THESPORTSDB_API_KEY}/eventsnextleague.php?id=${KBO_LEAGUE_ID}`;
    const response = await fetch(url);
    const data = await response.json();

    const events = (data.events || []).map((e) => {
      // API 필드 참고: dateEvent, strTime, strHomeTeam, strAwayTeam, intHomeScore, intAwayScore 등 :contentReference[oaicite:3]{index=3}
      const date = e.dateEvent || "";
      const time = e.strTime || "";
      const gameDate = time ? `${date} ${time}` : date;

      let score = null;
      if (e.intHomeScore && e.intAwayScore) {
        score = `${e.intHomeScore} - ${e.intAwayScore}`;
      }

      return {
        idEvent: e.idEvent,
        league: e.strLeague,
        game_date: gameDate,
        home_team: e.strHomeTeam,
        away_team: e.strAwayTeam,
        status: e.strStatus || "예정",
        score,
      };
    });

    res.json(events);
  } catch (err) {
    console.error("KBO 경기 정보 불러오기 오류:", err);
    res.status(500).json({ message: "외부 경기 정보를 불러오지 못했습니다." });
  }
});

// ============================
// 5. 프로필 관리
// ============================

app.get("/api/user/info", async (req, res) => {
  const { username } = req.query;

  if (!username)
    return res.status(400).json({ message: "username이 필요합니다." });

  try {
    const [rows] = await db.query(
      "SELECT id, username, nickname, intro, profile_image FROM users WHERE username = ?",
      [username]
    );

    if (rows.length === 0)
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });

    res.json(rows[0]);
  } catch (err) {
    console.error("프로필 조회 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

app.put("/api/user/password", async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;

  if (!username || !oldPassword || !newPassword)
    return res.status(400).json({ message: "필수 값 부족" });

  try {
    const [rows] = await db.query(
      "SELECT id FROM users WHERE username = ? AND password = ?",
      [username, oldPassword]
    );

    if (rows.length === 0)
      return res.status(400).json({ message: "현재 비밀번호 불일치" });

    await db.query("UPDATE users SET password = ? WHERE username = ?", [
      newPassword,
      username,
    ]);

    res.json({ message: "비밀번호 변경 완료" });
  } catch (err) {
    console.error("비밀번호 변경 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

app.put("/api/user/profile", async (req, res) => {
  const { username, intro, profileImage } = req.body;

  if (!username)
    return res.status(400).json({ message: "username 필요" });

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
  console.log(`🚀 Server + Socket.io Running on port ${PORT}`);
});
