CREATE TABLE IF NOT EXISTS ayarlar (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  dosya_acik INTEGER NOT NULL DEFAULT 1,
  dosya_baslangic TEXT DEFAULT '2026-11-12T21:00:00.000Z',
  dosya_bitis TEXT DEFAULT '2026-11-15T15:00:00.000Z',
  dilek_acik INTEGER NOT NULL DEFAULT 1,
  dilek_baslangic TEXT DEFAULT NULL,
  dilek_bitis TEXT DEFAULT '2026-11-15T15:00:00.000Z',
  dilekler_gorunur INTEGER NOT NULL DEFAULT 1,
  dilek_siniri INTEGER DEFAULT 3,
  dosya_siniri INTEGER DEFAULT 300,
  foto_mb INTEGER NOT NULL DEFAULT 40,
  video_mb INTEGER NOT NULL DEFAULT 100,
  guncellendi TEXT
);

INSERT OR IGNORE INTO ayarlar (id) VALUES (1);

CREATE TABLE IF NOT EXISTS dilekler (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zaman TEXT NOT NULL,
  isim TEXT NOT NULL,
  mesaj TEXT NOT NULL,
  cihaz TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS dilekler_cihaz ON dilekler (cihaz);

CREATE INDEX IF NOT EXISTS dilekler_zaman ON dilekler (zaman);

CREATE TABLE IF NOT EXISTS dosyalar (
  no INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  zaman TEXT NOT NULL,
  tamamlandi TEXT,
  tur TEXT NOT NULL CHECK (tur IN ('foto', 'video')),
  mime TEXT NOT NULL,
  boyut INTEGER NOT NULL,
  ad TEXT,
  isim TEXT,
  dilek_id INTEGER REFERENCES dilekler (id) ON DELETE SET NULL,
  cihaz TEXT NOT NULL,
  genislik INTEGER,
  yukseklik INTEGER,
  sure REAL,
  kucuk INTEGER NOT NULL DEFAULT 0,
  durum TEXT NOT NULL DEFAULT 'yukleniyor',
  anahtar TEXT NOT NULL,
  yukleme TEXT
);

CREATE INDEX IF NOT EXISTS dosyalar_cihaz ON dosyalar (cihaz);

CREATE INDEX IF NOT EXISTS dosyalar_dilek ON dosyalar (dilek_id);

CREATE INDEX IF NOT EXISTS dosyalar_zaman ON dosyalar (zaman);

CREATE TABLE IF NOT EXISTS sayac (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bayt INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO sayac (id, bayt) SELECT 1, COALESCE(SUM(boyut), 0) FROM dosyalar;

CREATE TABLE IF NOT EXISTS silinenler (
  dilek_id INTEGER NOT NULL,
  zaman TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS silinenler_zaman ON silinenler (zaman);

CREATE TABLE IF NOT EXISTS girisler (
  ip TEXT NOT NULL,
  zaman TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS girisler_ip_zaman ON girisler (ip, zaman);
