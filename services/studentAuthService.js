const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const generateStudentInitialPassword = async () => {
    const plaintext = crypto.randomBytes(5).toString('hex').toUpperCase();
    // Use cost 8 for temporary passwords to ensure extreme speed during bulk generation (500+ records in seconds)
    const hash = await bcrypt.hash(plaintext, 8);
    return { plaintext, hash };
};

module.exports = { generateStudentInitialPassword };
