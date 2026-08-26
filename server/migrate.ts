import { openDatabase } from './database';

const databasePath = process.env.TSUKUYOMI_DATABASE_PATH;
if (!databasePath) {
  console.error('TSUKUYOMI_DATABASE_PATH 未配置');
  process.exitCode = 1;
} else {
  const database = openDatabase(databasePath);
  try {
    console.log('SQLite migrations applied');
  } finally {
    database.close();
  }
}
