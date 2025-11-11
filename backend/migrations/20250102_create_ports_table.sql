CREATE TABLE IF NOT EXISTS ports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  port_number INT NOT NULL UNIQUE,
  country VARCHAR(64) NOT NULL,
  country_short VARCHAR(16) NOT NULL,
  provider VARCHAR(128) NOT NULL,
  provider_short VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO ports (port_number, country, country_short, provider, provider_short)
VALUES
  (10220, 'Spain', 'ES', 'Telecomunicaciones Publicas Andaluzas S.L.', 'TPA'),
  (10041, 'United Kingdom', 'UK', 'Virgin Media', 'VM'),
  (10079, 'Canada', 'CA', 'Bell Canada', 'Bell'),
  (10238, 'Italy', 'IT', 'EOLO S.p.A.', 'EOLO'),
  (10038, 'Portugal', 'PT', 'NOS Comunicacoes', 'NOS')
ON DUPLICATE KEY UPDATE
  country = VALUES(country),
  country_short = VALUES(country_short),
  provider = VALUES(provider),
  provider_short = VALUES(provider_short);


