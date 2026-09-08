-- ============================================================
-- Migration 019: Convert Intake Module ENUMs to VARCHAR(100) & Backfill
--
-- Modules affected:
--   - suggestions: status, priority -> VARCHAR(100)
--   - complaints:  status, priority -> VARCHAR(100)
--   - ideas:        status, priority -> VARCHAR(100)
--   - issues:       status, priority -> VARCHAR(100)
--   - cm_fund_requests: priority    -> VARCHAR(100)
-- ============================================================

-- 1. Alter suggestions
ALTER TABLE `suggestions`
  MODIFY COLUMN `status` VARCHAR(100) NOT NULL DEFAULT 'Pending',
  MODIFY COLUMN `priority` VARCHAR(100) NOT NULL DEFAULT 'Medium';

-- 2. Alter complaints
ALTER TABLE `complaints`
  MODIFY COLUMN `status` VARCHAR(100) NOT NULL DEFAULT 'Pending',
  MODIFY COLUMN `priority` VARCHAR(100) NOT NULL DEFAULT 'Medium';

-- 3. Alter ideas
ALTER TABLE `ideas`
  MODIFY COLUMN `status` VARCHAR(100) NOT NULL DEFAULT 'Pending',
  MODIFY COLUMN `priority` VARCHAR(100) NOT NULL DEFAULT 'Medium';

-- 4. Alter issues
ALTER TABLE `issues`
  MODIFY COLUMN `status` VARCHAR(100) NOT NULL DEFAULT 'Pending',
  MODIFY COLUMN `priority` VARCHAR(100) NOT NULL DEFAULT 'Medium';

-- 5. Alter cm_fund_requests
ALTER TABLE `cm_fund_requests`
  MODIFY COLUMN `priority` VARCHAR(100) NOT NULL DEFAULT 'Normal';

-- 6. Backfill suggestions with empty status
UPDATE `suggestions`
  SET `status` = 'test'
  WHERE `id` IN (8, 21) AND (`status` = '' OR `status` IS NULL);

UPDATE `suggestions`
  SET `status` = 'Pending'
  WHERE `status` = '' OR `status` IS NULL;

-- 7. Backfill complaints with empty status (submitted when 'Under Review' was default)
UPDATE `complaints`
  SET `status` = 'Under Review'
  WHERE (`status` = '' OR `status` IS NULL) AND `is_deleted` = 0;

-- 8. Safeguard ideas & issues
UPDATE `ideas`
  SET `status` = 'Pending'
  WHERE (`status` = '' OR `status` IS NULL) AND `is_deleted` = 0;

UPDATE `issues`
  SET `status` = 'Under Process'
  WHERE (`status` = '' OR `status` IS NULL) AND `is_deleted` = 0;
