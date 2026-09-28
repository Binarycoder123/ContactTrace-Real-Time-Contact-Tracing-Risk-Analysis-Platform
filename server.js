/**
 * server.js
 * Entry point for the PathoTrace API. Loads config, connects DB, mounts routes,
 * and enables global error handling middleware.
 */
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const connectDB = require('./config/db');

const patientRoutes = require('./routes/patientRoutes');
const staffRoutes = require('./routes/staffRoutes');
const interactionRoutes = require('./routes/interactionRoutes');
const visitRoutes = require('./routes/visitRoutes');
const riskRoutes = require('./routes/riskRoutes');
const { notFound, errorHandler } = require('./middleware/errorMiddleware');

dotenv.config();
connectDB();

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'PathoTrace API is running' });
});

app.use('/api/patients', patientRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/interactions', interactionRoutes);
app.use('/api/visit', visitRoutes);
app.use('/api/risk', riskRoutes);
app.use("/api/risk", require("./routes/riskRoutes"));

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`PathoTrace server running on port ${PORT}`);
});
