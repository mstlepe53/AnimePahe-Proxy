import express from 'express';
import { registerDownloadRoutes } from './download-handler.js';

const PORT = process.env.DOWNLOAD_PORT || process.env.PORT || 3001;
const app = express();

registerDownloadRoutes(app);

app.listen(PORT, () => {
    console.log(`Download proxy listening on PORT: ${PORT}`);
});
