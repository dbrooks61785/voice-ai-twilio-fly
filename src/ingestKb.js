import 'dotenv/config';
import { ingestKb } from './kb.js';

const {
  OPENAI_API_KEY,
  OPENAI_EMBEDDING_MODEL,
  KB_INDEX_PATH,
  KB_MAX_PAGES,
  KB_MIN_CHARS,
  KB_CHUNK_SIZE,
  KB_CHUNK_OVERLAP,
  KB_EZ_BASE_URL,
  KB_HAULPASS_HOME
} = process.env;

const maxPages = Number.isNaN(Number(KB_MAX_PAGES)) ? undefined : Number(KB_MAX_PAGES);
const minChars = Number.isNaN(Number(KB_MIN_CHARS)) ? undefined : Number(KB_MIN_CHARS);
const chunkSize = Number.isNaN(Number(KB_CHUNK_SIZE)) ? undefined : Number(KB_CHUNK_SIZE);
const chunkOverlap = Number.isNaN(Number(KB_CHUNK_OVERLAP)) ? undefined : Number(KB_CHUNK_OVERLAP);

ingestKb({
  apiKey: OPENAI_API_KEY,
  embeddingModel: OPENAI_EMBEDDING_MODEL,
  indexPath: KB_INDEX_PATH,
  maxPages,
  minChars,
  chunkSize,
  chunkOverlap,
  ezBaseUrl: KB_EZ_BASE_URL,
  haulpassHome: KB_HAULPASS_HOME,
  log: console
}).catch((err) => {
  console.error('KB ingestion failed:', err);
  process.exit(1);
});
