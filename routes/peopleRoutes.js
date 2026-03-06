
import express from 'express';
import multer from 'multer';
import { getPeople, getPersonById, deletePerson, createPerson, updatePerson, importPeople } from '../controllers/peopleController.js';
import { verifyToken } from '../middlewares/auth.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

// Apply auth to all admin people routes
router.use(verifyToken);

router.get('/', getPeople);
router.post('/import', upload.single('file'), importPeople);
router.get('/:id', getPersonById);
router.post('/', createPerson);
router.put('/:id', updatePerson);
router.delete('/:id', deletePerson);

export default router;
