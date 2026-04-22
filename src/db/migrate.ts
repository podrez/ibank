import 'dotenv/config';
import { runMigrations } from './index';

runMigrations();
console.log('Migrations applied successfully');
