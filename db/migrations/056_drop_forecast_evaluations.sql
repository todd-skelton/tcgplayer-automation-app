-- Drops the Node app's forecast calibration records. Nothing in the app reads or writes them since
-- the /api routes were retired, and the production backups keep their rows. Correction events go
-- first, since they point at evaluations. Not marked online: the release stops the running app
-- before migrating, as for any dropped table, though that release never reads them either.
DROP TABLE IF EXISTS forecast_correction_events;
DROP TABLE IF EXISTS forecast_evaluations;
