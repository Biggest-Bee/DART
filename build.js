const fs = require('fs');
const path = require('path');
require('dotenv').config();

const envSecret = process.env.DART_ADMIN_SECRET;
if (!envSecret) {
  console.error('Error: DART_ADMIN_SECRET not found in .env file');
  process.exit(1);
}

const indexPath = path.join(__dirname, 'public', 'index.html');
let indexContent = fs.readFileSync(indexPath, 'utf8');

// Replace placeholder with actual secret
indexContent = indexContent.replace('DART_ADMIN_SECRET', envSecret);

fs.writeFileSync(indexPath, indexContent);
console.log('✓ Build complete: Secret replaced in index.html');
