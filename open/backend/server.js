// ============================
// YB Sports Backend (전체 버전)
// ============================

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2");

// ----------------------------
// 기본 설정
// ----------------------------
const app = express();
const PORT = 3000;

// CORS 허용 (프론트 주소 나중에 바꿔도 됨)
app.use(
  cors({
    origin: "*", // 개발 단계라 전체 허용. 나중에 'http://localhost:5500' 등으로 좁혀도 됨.
  })
);

app.use(express.json()); // JSON 요청
app.use(express.urlencoded({ extended: true })); // 폼 요청

// ----------------------------
// MySQL 연결 설정
// ----------------------------
// Render 환경변수 사용
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
// (참고) DB & 테이블 만들기용 SQL
// MySQL Workbench 에서 아래를 실행해줘
// ----------------------------
/*
CREATE DATABASE IF NOT EXISTS ybsports;
USE ybsports;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  nickname VARCHAR(50) NOT NULL,
  profile_image TEXT NULL,
  intro VARCHAR(200) DEFAULT ''
);

CREATE TABLE IF NOT EXISTS posts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  writer VARCHAR(50) NOT NULL,
  password VARCHAR(20) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  views INT NOT NULL DEFAULT 0,
  likes INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  post_id INT NOT NULL,
  writer VARCHAR(50) NOT NULL,
  content TEXT NOT NULL,
  password VARCHAR(20) NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS games (
  id INT AUTO_INCREMENT PRIMARY KEY,
  home_team VARCHAR(50),
  away_team VARCHAR(50),
  game_date DATETIME,
  status VARCHAR(20),
  score VARCHAR(20)
);
*/

// ----------------------------
// 기본 테스트용 라우트
// ----------------------------
app.get("/", (req, res) => {
  res.send("YB Sports Backend Running!");
});

// ============================
// 1. 회원가입 / 로그인 (Auth)
// ============================

// 회원가입
// POST /api/register
// body: { username, password, nickname }
app.post("/api/register", async (req, res) => {
  const { username, password, nickname } = req.body;

  if (!username || !password || !nickname) {
    return res.status(400).json({ message: "필수 값이 비어 있습니다." });
  }

  try {
    // username 중복 체크
    const [existRows] = await db.query(
      "SELECT id FROM users WHERE username = ?",
      [username]
    );

    if (existRows.length > 0) {
      return res.status(409).json({ message: "이미 존재하는 아이디입니다." });
    }

    // ⚠️ 지금은 패스워드 평문 저장 (프로젝트용)
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
// POST /api/login
// body: { username, password }
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: "아이디와 비밀번호를 입력하세요." });
  }

  try {
    const [rows] = await db.query(
      "SELECT id, username, password, nickname FROM users WHERE username = ?",
      [username]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: "존재하지 않는 아이디입니다." });
    }

    const user = rows[0];

    if (user.password !== password) {
      return res.status(401).json({ message: "비밀번호가 올바르지 않습니다." });
    }

    // 세션/토큰은 나중에. 일단은 정보만 돌려줌.
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
// 2. 게시글 (Posts)
// ============================

// 게시글 목록
// GET /api/posts
app.get("/api/posts", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, title, content, writer, created_at, views, likes FROM posts ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("게시글 목록 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// 게시글 작성
// POST /api/posts
// body: { title, content, writer, password }
app.post("/api/posts", async (req, res) => {
  const { title, content, writer, password } = req.body;

  if (!title || !content || !writer || !password) {
    return res.status(400).json({ message: "필수 값이 비어 있습니다." });
  }

  try {
    const [result] = await db.query(
      "INSERT INTO posts (title, content, writer, password) VALUES (?, ?, ?, ?)",
      [title, content, writer, password]
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

// 게시글 상세 + 조회수 증가
// GET /api/posts/:id
app.get("/api/posts/:id", async (req, res) => {
  const postId = req.params.id;

  try {
    // 조회수 +1
    await db.query("UPDATE posts SET views = views + 1 WHERE id = ?", [
      postId,
    ]);

    // 글 정보 가져오기
    const [rows] = await db.query(
      "SELECT id, title, content, writer, created_at, views, likes FROM posts WHERE id = ?",
      [postId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "게시글을 찾을 수 없습니다." });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("게시글 상세 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// 게시글 수정
// PUT /api/posts/:id
// body: { title, content, password }
app.put("/api/posts/:id", async (req, res) => {
  const postId = req.params.id;
  const { title, content, password } = req.body;

  if (!title || !content || !password) {
    return res.status(400).json({ message: "필수 값이 비어 있습니다." });
  }

  try {
    const [rows] = await db.query(
      "SELECT id, password FROM posts WHERE id = ?",
      [postId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "게시글을 찾을 수 없습니다." });
    }

    const post = rows[0];

    if (post.password !== password) {
      return res.status(403).json({ message: "비밀번호가 일치하지 않습니다." });
    }

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

// 게시글 삭제
// DELETE /api/posts/:id
// body: { password }
app.delete("/api/posts/:id", async (req, res) => {
  const postId = req.params.id;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ message: "비밀번호를 입력해주세요." });
  }

  try {
    const [rows] = await db.query(
      "SELECT id, password FROM posts WHERE id = ?",
      [postId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "게시글을 찾을 수 없습니다." });
    }

    const post = rows[0];

    if (post.password !== password) {
      return res.status(403).json({ message: "비밀번호가 일치하지 않습니다." });
    }

    await db.query("DELETE FROM posts WHERE id = ?", [postId]);

    res.json({ message: "게시글이 삭제되었습니다." });
  } catch (err) {
    console.error("게시글 삭제 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// 게시글 좋아요 +1
// POST /api/posts/:id/like
app.post("/api/posts/:id/like", async (req, res) => {
  const { id } = req.params;

  try {
    await db.query("UPDATE posts SET likes = likes + 1 WHERE id = ?", [id]);

    const [rows] = await db.query(
      "SELECT id, likes FROM posts WHERE id = ?",
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "게시글을 찾을 수 없습니다." });
    }

    res.json({ message: "좋아요!", likes: rows[0].likes });
  } catch (err) {
    console.error("좋아요 처리 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// 인기글 TOP 5 (좋아요 우선, 그다음 조회수)
app.get("/api/posts/popular", async (req, res) => {
  try {
    const [rows] = await db.query(
      "SELECT id, title, writer, created_at, views, likes FROM posts ORDER BY likes DESC, views DESC LIMIT 5"
    );
    res.json(rows);
  } catch (err) {
    console.error("인기글 조회 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});


// ============================
// 3. 댓글 (Comments)
// ============================

// 특정 게시글의 댓글 목록
// GET /api/comments/:postId
app.get("/api/comments/:postId", async (req, res) => {
  const postId = req.params.postId;

  try {
    const [rows] = await db.query(
      "SELECT id, post_id, writer, content, created_at FROM comments WHERE post_id = ? ORDER BY id ASC",
      [postId]
    );
    res.json(rows);
  } catch (err) {
    console.error("댓글 목록 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// 댓글 작성
// POST /api/comments
// body: { postId, writer, content, password }
app.post("/api/comments", async (req, res) => {
  const { postId, writer, content, password } = req.body;

  if (!postId || !writer || !content || !password) {
    return res.status(400).json({ message: "필수 값이 비어 있습니다." });
  }

  try {
    await db.query(
      "INSERT INTO comments (post_id, writer, content, password) VALUES (?, ?, ?, ?)",
      [postId, writer, content, password]
    );

    res.status(201).json({ message: "댓글이 등록되었습니다." });
  } catch (err) {
    console.error("댓글 작성 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// 댓글 삭제 (비밀번호 확인)
// DELETE /api/comments/:id
// body: { password }
app.delete("/api/comments/:id", async (req, res) => {
  const commentId = req.params.id;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ message: "비밀번호를 입력해주세요." });
  }

  try {
    const [rows] = await db.query(
      "SELECT id, password FROM comments WHERE id = ?",
      [commentId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "댓글을 찾을 수 없습니다." });
    }

    const comment = rows[0];

    if (comment.password !== password) {
      return res.status(403).json({ message: "비밀번호가 일치하지 않습니다." });
    }

    await db.query("DELETE FROM comments WHERE id = ?", [commentId]);

    res.json({ message: "댓글이 삭제되었습니다." });
  } catch (err) {
    console.error("댓글 삭제 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// ============================
// 4. 경기 정보 (Games)
// ============================

// 경기 목록
// GET /api/games
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
// POST /api/games
// body: { home_team, away_team, game_date, status, score }
app.post("/api/games", async (req, res) => {
  const { home_team, away_team, game_date, status, score } = req.body;

  if (!home_team || !away_team || !game_date) {
    return res.status(400).json({ message: "필수 값이 비어 있습니다." });
  }

  try {
    const [result] = await db.query(
      "INSERT INTO games (home_team, away_team, game_date, status, score) VALUES (?, ?, ?, ?, ?)",
      [home_team, away_team, game_date, status || "", score || ""]
    );
    res.status(201).json({
      message: "경기 정보가 추가되었습니다.",
      gameId: result.insertId,
    });
  } catch (err) {
    console.error("경기 추가 오류:", err);
    res.status(500).json({ message: "서버 오류" });
  }
});

// ============================
// 5. 마이페이지 / 사용자 프로필 관련
// ============================

// 프로필 정보 조회
// GET /api/user/info?username=xxx
app.get("/api/user/info", async (req, res) => {
  const { username } = req.query;

  if (!username) {
    return res.status(400).json({ message: "username이 필요합니다." });
  }

  try {
    const [rows] = await db.query(
      "SELECT id, username, nickname, intro, profile_image FROM users WHERE username = ?",
      [username]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "사용자를 찾을 수 없습니다." });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error("프로필 조회 오류:", err);
    return res.status(500).json({ message: "서버 오류" });
  }
});

// 비밀번호 변경
// PUT /api/user/password
// body: { username, oldPassword, newPassword }
app.put("/api/user/password", async (req, res) => {
  const { username, oldPassword, newPassword } = req.body;

  if (!username || !oldPassword || !newPassword) {
    return res.status(400).json({ message: "필수 정보가 부족합니다." });
  }

  try {
    const [rows] = await db.query(
      "SELECT id FROM users WHERE username = ? AND password = ?",
      [username, oldPassword]
    );

    if (rows.length === 0) {
      return res
        .status(400)
        .json({ message: "현재 비밀번호가 일치하지 않습니다." });
    }

    await db.query("UPDATE users SET password = ? WHERE username = ?", [
      newPassword,
      username,
    ]);

    return res.json({ message: "비밀번호가 변경되었습니다." });
  } catch (err) {
    console.error("비밀번호 변경 오류:", err);
    return res.status(500).json({ message: "서버 오류" });
  }
});

// 회원 탈퇴
// DELETE /api/user/delete
// body: { username, password }
app.delete("/api/user/delete", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ message: "필수 정보가 부족합니다." });
  }

  try {
    const [rows] = await db.query(
      "SELECT id FROM users WHERE username = ? AND password = ?",
      [username, password]
    );

    if (rows.length === 0) {
      return res
        .status(400)
        .json({ message: "비밀번호가 일치하지 않습니다." });
    }

    await db.query("DELETE FROM users WHERE username = ?", [username]);

    return res.json({ message: "회원 탈퇴가 완료되었습니다." });
  } catch (err) {
    console.error("회원 탈퇴 오류:", err);
    return res.status(500).json({ message: "서버 오류" });
  }
});

// 프로필 정보 업데이트 (프로필 이미지, 한줄 소개)
// PUT /api/user/profile
// body: { username, intro, profileImage }
app.put("/api/user/profile", async (req, res) => {
  const { username, intro, profileImage } = req.body;

  if (!username) {
    return res.status(400).json({ message: "username이 필요합니다." });
  }

  try {
    await db.query(
      "UPDATE users SET intro = ?, profile_image = ? WHERE username = ?",
      [intro || "", profileImage || null, username]
    );

    return res.json({ message: "프로필이 업데이트되었습니다." });
  } catch (err) {
    console.error("프로필 업데이트 오류:", err);
    return res.status(500).json({ message: "서버 오류" });
  }
});

// ============================
// 서버 실행
// ============================
app.listen(PORT, () => {
  console.log(`YB Sports Backend Server Running on http://localhost:${PORT}`);
});
