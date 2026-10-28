-- Sample data for testing the database features of Kestrel.
-- The big inserts below use recursive CTEs with more than 1000 steps.
SET SESSION cte_max_recursion_depth = 100000;
-- The file is UTF-8. Without this, Japanese, Korean and Vietnamese text is stored double-encoded.
SET NAMES utf8mb4;
CREATE DATABASE IF NOT EXISTS kestrel_demo CHARACTER SET utf8mb4;
CREATE DATABASE IF NOT EXISTS kestrel_logs CHARACTER SET utf8mb4;
USE kestrel_demo;

CREATE TABLE authors (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL COMMENT 'Pen name',
  country CHAR(2) NOT NULL DEFAULT 'JP',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='Comic authors';

CREATE TABLE titles (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  author_id INT UNSIGNED NOT NULL,
  name VARCHAR(200) NOT NULL,
  genre ENUM('action','romance','comedy','drama','fantasy') NOT NULL,
  rating DECIMAL(3,2) NULL,
  is_completed TINYINT(1) NOT NULL DEFAULT 0,
  meta JSON NULL,
  published_on DATE NULL,
  KEY idx_titles_author (author_id),
  KEY idx_titles_genre_rating (genre, rating),
  CONSTRAINT fk_titles_author FOREIGN KEY (author_id) REFERENCES authors (id)
) ENGINE=InnoDB;

CREATE TABLE episodes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title_id INT UNSIGNED NOT NULL,
  no SMALLINT UNSIGNED NOT NULL,
  name VARCHAR(200) NOT NULL,
  price_coin INT NOT NULL DEFAULT 0,
  thumbnail BLOB NULL,
  released_at DATETIME(3) NULL,
  UNIQUE KEY uk_episodes_title_no (title_id, no),
  CONSTRAINT fk_episodes_title FOREIGN KEY (title_id) REFERENCES titles (id)
) ENGINE=InnoDB;

INSERT INTO authors (name, country) VALUES
  ('Sakura Mori', 'JP'), ('Kim Minji', 'KR'), ('Nguyễn Lan', 'VN'), ('John Park', 'US'), ('Tanaka Ren', 'JP');

INSERT INTO titles (author_id, name, genre, rating, is_completed, meta, published_on) VALUES
  (1, '月の剣士', 'action', 4.70, 0, '{"tags": ["sword", "moon"], "weekly": true}', '2021-04-01'),
  (2, '여름의 끝', 'romance', 4.20, 1, '{"tags": ["school"]}', '2019-07-15'),
  (3, 'Hà Nội về đêm', 'drama', 4.55, 0, NULL, '2023-01-20'),
  (4, 'Pixel Knights', 'fantasy', 3.90, 0, '{"tags": ["game", "isekai"]}', '2022-11-02'),
  (5, '猫と僕', 'comedy', NULL, 0, NULL, NULL);

-- 5 titles x 200 episodes = 1000 rows.
INSERT INTO episodes (title_id, no, name, price_coin, released_at)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200)
SELECT t.id, seq.n, CONCAT('Episode ', seq.n), IF(seq.n <= 3, 0, 30 + (seq.n % 3) * 10),
       TIMESTAMP('2024-01-01 12:00:00.000') + INTERVAL (t.id * 200 + seq.n) DAY
FROM titles t CROSS JOIN seq;

CREATE VIEW title_stats AS
SELECT t.id, t.name, a.name AS author, COUNT(e.id) AS episodes, SUM(e.price_coin) AS total_coin
FROM titles t JOIN authors a ON a.id = t.author_id LEFT JOIN episodes e ON e.title_id = t.id
GROUP BY t.id, t.name, a.name;

DELIMITER //
CREATE PROCEDURE free_episodes(IN p_title INT)
BEGIN
  SELECT no, name FROM episodes WHERE title_id = p_title AND price_coin = 0 ORDER BY no;
END //
CREATE FUNCTION coin_to_yen(p_coin INT) RETURNS INT DETERMINISTIC
BEGIN
  RETURN p_coin * 3;
END //
CREATE TRIGGER trg_episodes_price BEFORE INSERT ON episodes FOR EACH ROW
BEGIN
  IF NEW.price_coin < 0 THEN SET NEW.price_coin = 0; END IF;
END //
DELIMITER ;

USE kestrel_logs;
CREATE TABLE access_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  path VARCHAR(255) NOT NULL,
  status SMALLINT NOT NULL,
  at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY idx_access_user (user_id, at)
) ENGINE=InnoDB;

-- 50k rows for big result tests.
INSERT INTO access_log (user_id, path, status, at)
WITH RECURSIVE seq (n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50000)
SELECT n % 997, CONCAT('/api/titles/', n % 5 + 1, '/episodes/', n % 200 + 1), IF(n % 50 = 0, 500, 200),
       TIMESTAMP('2026-10-01 00:00:00') + INTERVAL n SECOND
FROM seq;
