const studentService = require('../services/studentService');

const getFilters = async (req, res, next) => {
    try {
        res.json(await studentService.getFilters(req.user));
    } catch (error) {
        next(error);
    }
};

const getStudentsByFilter = async (req, res, next) => {
    try {
        res.json(await studentService.getStudentsByFilter({ ...req.query, actor: req.user }));
    } catch (error) {
        next(error);
    }
};

const getAllStudents = async (req, res, next) => {
    try {
        res.json(await studentService.getAllStudents(req.query, req.user));
    } catch (error) {
        next(error);
    }
};

const uploadStudents = async (req, res, next) => {
    try {
        const result = await studentService.uploadStudents({
            filePath: req.file?.path,
            actor: req.user,
        });
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

const deleteStudent = async (req, res, next) => {
    try {
        res.json(await studentService.deleteStudent({
            studentId: req.params.id,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

const createStudent = async (req, res, next) => {
    try {
        const student = await studentService.createStudent({
            input: req.body,
            actor: req.user,
        });
        res.status(201).json(student);
    } catch (error) {
        next(error);
    }
};

const getStudentBehavioralSummary = async (req, res, next) => {
    try {
        res.json(await studentService.getStudentBehavioralSummary(req.params.id, req.user));
    } catch (error) {
        next(error);
    }
};

const updateStudent = async (req, res, next) => {
    try {
        res.json(await studentService.updateStudent({
            studentId: req.params.id,
            input: req.body,
            actor: req.user,
        }));
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getFilters,
    getStudentsByFilter,
    getAllStudents,
    uploadStudents,
    deleteStudent,
    createStudent,
    updateStudent,
    getStudentBehavioralSummary,
};
