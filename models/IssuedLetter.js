const mongoose = require('mongoose');
const IssuedLetterCounter = require('./IssuedLetterCounter');

const issuedLetterSchema = new mongoose.Schema({
    letterNumber: {
        type: String
    },
    schoolId: {
        type: String,
        required: true,
        immutable: true,
        uppercase: true,
        trim: true,
    },
    academicYear: {
        type: String,
        trim: true,
    },
    incident: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Incident',
        required: true
    },
    studentName: {
        type: String,
        required: true
    },
    admissionNo: {
        type: String,
        default: ''
    },
    className: {
        type: String,
        default: ''
    },
    section: {
        type: String,
        default: ''
    },
    incidentCategory: {
        type: String,
        required: true
    },
    templateId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'LetterTemplate',
        required: true
    },
    title: {
        type: String,
        required: true
    },
    generatedDocx: {
        type: Buffer,
        default: null
    },
    generatedDocxKey: {
        type: String,
        default: ''
    },
    generatedDocxUrl: {
        type: String,
        default: ''
    },
    issuedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    status: {
        type: String,
        enum: ['Issued', 'Printed', 'Sent'],
        default: 'Issued'
    },
    language: {
        type: String,
        default: 'en'
    },
    printedAt: {
        type: Date,
        default: null
    },
    notes: {
        type: String,
        default: ''
    },
    generatedAt: {
        type: Date,
        default: Date.now
    }
}, { 
    timestamps: true,
    collection: 'issued_letters'
});

issuedLetterSchema.index({ schoolId: 1, letterNumber: 1 }, { unique: true });
issuedLetterSchema.index({ schoolId: 1, studentName: 1, className: 1 });
issuedLetterSchema.index({ schoolId: 1, className: 1, section: 1 });
issuedLetterSchema.index({ schoolId: 1, admissionNo: 1, generatedAt: -1 });
issuedLetterSchema.index({ schoolId: 1, incident: 1, generatedAt: -1 });
issuedLetterSchema.index({ schoolId: 1, incidentCategory: 1, generatedAt: -1 });
issuedLetterSchema.index({ schoolId: 1, status: 1, generatedAt: -1 });
issuedLetterSchema.index({ schoolId: 1, generatedAt: -1 });
issuedLetterSchema.index({ schoolId: 1, academicYear: 1, generatedAt: -1 });

const getExistingMaxLetterSequence = async (IssuedLetterModel, schoolId, year, session = null) => {
    let query = IssuedLetterModel.findOne({
        schoolId,
        letterNumber: new RegExp(`^LET-${year}-`)
    }).sort({ letterNumber: -1 }).select('letterNumber').lean();
    if (session) query = query.session(session);
    const lastLetter = await query;

    const match = lastLetter?.letterNumber?.match(/LET-\d{4}-(\d+)/);
    return match?.[1] ? parseInt(match[1], 10) : 0;
};

const ensureLetterCounter = async (IssuedLetterModel, schoolId, year, counterId, session = null) => {
    const existingMax = await getExistingMaxLetterSequence(IssuedLetterModel, schoolId, year, session);

    try {
        return await IssuedLetterCounter.findOneAndUpdate(
            { _id: counterId },
            {
                $setOnInsert: {
                    _id: counterId,
                    schoolId,
                    scope: 'issuedLetter',
                    year,
                    seq: existingMax,
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true, session }
        );
    } catch (error) {
        if (error.code === 11000) {
            let query = IssuedLetterCounter.findById(counterId);
            if (session) query = query.session(session);
            return query;
        }
        throw error;
    }
};

issuedLetterSchema.statics.generateLetterNumber = async function(schoolId, options = {}) {
    const normalizedSchoolId = String(schoolId || '').toUpperCase().trim();
    const year = new Date().getFullYear();
    const counterId = `${normalizedSchoolId}:issuedLetter:${year}`;
    const session = options.session || null;

    await ensureLetterCounter(this, normalizedSchoolId, year, counterId, session);

    const counter = await IssuedLetterCounter.findOneAndUpdate(
        { _id: counterId },
        {
            $inc: { seq: 1 },
            $set: {
                schoolId: normalizedSchoolId,
                scope: 'issuedLetter',
                year,
            },
        },
        { new: true, session }
    ).lean();

    return `LET-${year}-${String(counter.seq).padStart(5, '0')}`;
};

issuedLetterSchema.statics.getStats = async function(query = {}) {
    const stats = await this.aggregate([
        { $match: query },
        {
            $group: {
                _id: '$status',
                count: { $sum: 1 }
            }
        }
    ]);
    
    const result = { total: 0, Issued: 0, Printed: 0, Sent: 0 };
    stats.forEach(s => {
        result[s._id] = s.count;
        result.total += s.count;
    });
    return result;
};

module.exports = mongoose.model('IssuedLetter', issuedLetterSchema);
