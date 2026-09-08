-- ============================================================
-- 020: Make category columns nullable across all intake tables
-- ============================================================

ALTER TABLE complaints  MODIFY COLUMN category VARCHAR(255) NULL DEFAULT NULL;
ALTER TABLE issues      MODIFY COLUMN category VARCHAR(150) NULL DEFAULT NULL;
ALTER TABLE ideas       MODIFY COLUMN category VARCHAR(255) NULL DEFAULT NULL;
ALTER TABLE suggestions MODIFY COLUMN category VARCHAR(255) NULL DEFAULT NULL;

-- Clear default flag on system_category options
UPDATE mla_dropdown_lists SET is_default = 0 WHERE `key` = 'system_category';
