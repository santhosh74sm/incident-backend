const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate.middleware');
const { globalSearch } = require('../controllers/searchController');
const { globalSearchQuerySchema } = require('../validators/searchValidators');

router.get('/global', protect, validate(globalSearchQuerySchema, 'query'), globalSearch);

module.exports = router;
