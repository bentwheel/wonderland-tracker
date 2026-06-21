'use strict';

// Idempotent schema migration. Requiring db.js applies schema.sql on import,
// so this script just triggers that and reports. Safe to run repeatedly.
//
//   node migrate.js

require('./db');
console.log('Migration complete: schema.sql applied.');
process.exit(0);
