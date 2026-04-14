import express from 'express';
import {
  initDatabase,
  createProject,
  getProject,
  listProjects,
  agreeCovenant,
  getIntakeAnswers,
  setIntakeAnswer,
  getApprovals,
  addApproval,
  getVaultAssets as dbGetVaultAssets,
} from './database.js';
import {
  STAGES,
  transitionStage,
  advancePipeline,
  getPipelineSummary,
  checkIntakeGate,
} from './pipeline.js';
import { ensureProjectDir, listAssets, saveAsset, readAsset, approveAsset } from './vault.js';

const router = express.Router();

/**
 * Generate a unique project ID.
 */
function generateProjectId() {
  return 'proj_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// --- Project Endpoints ---

/**
 * POST /api/opal/projects - Create a new OPAL project
 */
router.post('/projects', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Project name is required' });
    }

    const id = generateProjectId();
    const project = createProject(id, name.trim());
    ensureProjectDir(id);

    console.log('[OPAL] Project created:', id, name);
    res.status(201).json(project);
  } catch (error) {
    console.error('[OPAL] Error creating project:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/opal/projects - List all projects
 */
router.get('/projects', (_req, res) => {
  try {
    const projects = listProjects();
    res.json(projects);
  } catch (error) {
    console.error('[OPAL] Error listing projects:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/opal/projects/:id - Get project with pipeline state
 */
router.get('/projects/:id', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(project);
  } catch (error) {
    console.error('[OPAL] Error getting project:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/opal/projects/:id/summary - Get pipeline summary
 */
router.get('/projects/:id/summary', (req, res) => {
  try {
    const summary = getPipelineSummary(req.params.id);
    if (!summary) {
      return res.status(404).json({ error: 'Project not found' });
    }
    res.json(summary);
  } catch (error) {
    console.error('[OPAL] Error getting summary:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Covenant Gate (Stage 0) ---

/**
 * POST /api/opal/projects/:id/covenant - Agree to covenant
 */
router.post('/projects/:id/covenant', (req, res) => {
  try {
    const { identity } = req.body;
    if (!identity || !identity.trim()) {
      return res.status(400).json({ error: 'Decision-maker identity is required' });
    }

    const project = getProject(req.params.id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (project.covenant_agreed_at) {
      return res.status(400).json({ error: 'Covenant already agreed to' });
    }

    agreeCovenant(req.params.id, identity.trim());

    console.log('[OPAL] Covenant agreed for project:', req.params.id, 'by:', identity);
    res.json({ success: true, message: 'Covenant accepted. Stage 1 unlocked.' });
  } catch (error) {
    console.error('[OPAL] Error agreeing to covenant:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Pipeline State ---

/**
 * POST /api/opal/projects/:id/stages/:stage/transition - Transition a stage
 */
router.post('/projects/:id/stages/:stage/transition', (req, res) => {
  try {
    const { status, node } = req.body;
    const stage = parseInt(req.params.stage);

    if (isNaN(stage) || stage < 0 || stage > 6) {
      return res.status(400).json({ error: 'Invalid stage number (0-6)' });
    }
    if (!status) {
      return res.status(400).json({ error: 'Target status is required' });
    }

    const result = transitionStage(req.params.id, stage, status, node);

    if (!result.success) {
      return res.status(400).json(result);
    }

    const updatedProject = getProject(req.params.id);
    res.json({ success: true, project: updatedProject });
  } catch (error) {
    console.error('[OPAL] Error transitioning stage:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/opal/projects/:id/advance - Advance pipeline to next state
 */
router.post('/projects/:id/advance', (req, res) => {
  try {
    const result = advancePipeline(req.params.id);

    if (!result.success) {
      return res.status(400).json(result);
    }

    const updatedProject = getProject(req.params.id);
    res.json({ success: true, ...result, project: updatedProject });
  } catch (error) {
    console.error('[OPAL] Error advancing pipeline:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Intake (Stage 1) ---

/**
 * GET /api/opal/projects/:id/intake - Get intake answers
 */
router.get('/projects/:id/intake', (req, res) => {
  try {
    const answers = getIntakeAnswers(req.params.id);
    const gateCheck = checkIntakeGate(req.params.id);
    res.json({ answers, gate: gateCheck });
  } catch (error) {
    console.error('[OPAL] Error getting intake:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/opal/projects/:id/intake - Save intake answers
 */
router.post('/projects/:id/intake', (req, res) => {
  try {
    const { section, key, value } = req.body;
    if (!section || !key) {
      return res.status(400).json({ error: 'Section and key are required' });
    }

    setIntakeAnswer(req.params.id, section, key, value);
    res.json({ success: true });
  } catch (error) {
    console.error('[OPAL] Error saving intake answer:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/opal/projects/:id/intake/batch - Save multiple intake answers at once
 */
router.post('/projects/:id/intake/batch', (req, res) => {
  try {
    const { answers } = req.body;
    if (!answers || !Array.isArray(answers)) {
      return res.status(400).json({ error: 'Answers array is required' });
    }

    for (const { section, key, value } of answers) {
      if (section && key) {
        setIntakeAnswer(req.params.id, section, key, value);
      }
    }

    const gateCheck = checkIntakeGate(req.params.id);
    res.json({ success: true, gate: gateCheck });
  } catch (error) {
    console.error('[OPAL] Error saving batch intake:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Vault ---

/**
 * GET /api/opal/projects/:id/vault - List vault assets
 */
router.get('/projects/:id/vault', (req, res) => {
  try {
    const type = req.query.type || null;
    const assets = listAssets(req.params.id, type);
    res.json(assets);
  } catch (error) {
    console.error('[OPAL] Error listing vault assets:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/opal/projects/:id/vault - Save an asset to the vault
 */
router.post('/projects/:id/vault', (req, res) => {
  try {
    const { type, stage, filename, content, metadata } = req.body;
    if (!type || stage === undefined || !filename || !content) {
      return res.status(400).json({ error: 'type, stage, filename, and content are required' });
    }

    const result = saveAsset(req.params.id, type, stage, filename, content, metadata || {});
    res.status(201).json(result);
  } catch (error) {
    console.error('[OPAL] Error saving vault asset:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/opal/projects/:id/vault/:assetId/approve - Approve a vault asset
 */
router.post('/projects/:id/vault/:assetId/approve', (req, res) => {
  try {
    approveAsset(req.params.assetId);
    res.json({ success: true });
  } catch (error) {
    console.error('[OPAL] Error approving asset:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Approvals ---

/**
 * GET /api/opal/projects/:id/approvals - Get approval history
 */
router.get('/projects/:id/approvals', (req, res) => {
  try {
    const stage = req.query.stage !== undefined ? parseInt(req.query.stage) : null;
    const approvals = getApprovals(req.params.id, stage);
    res.json(approvals);
  } catch (error) {
    console.error('[OPAL] Error getting approvals:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/opal/projects/:id/approvals - Submit an approval decision
 */
router.post('/projects/:id/approvals', (req, res) => {
  try {
    const { stage, node, approvedBy, approved, notes } = req.body;
    if (stage === undefined || !approvedBy || approved === undefined) {
      return res.status(400).json({ error: 'stage, approvedBy, and approved are required' });
    }

    addApproval(req.params.id, stage, node || null, approvedBy, approved, notes || '');

    // If approved, advance the stage; if rejected, go back to active
    if (approved) {
      transitionStage(req.params.id, stage, 'completed');
    } else {
      transitionStage(req.params.id, stage, 'active');
    }

    const updatedProject = getProject(req.params.id);
    res.json({ success: true, project: updatedProject });
  } catch (error) {
    console.error('[OPAL] Error submitting approval:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Stage Definitions ---

/**
 * GET /api/opal/stages - Get all stage definitions
 */
router.get('/stages', (_req, res) => {
  res.json(STAGES);
});

/**
 * Register OPAL routes on the Express app.
 */
export function registerOpalRoutes(app) {
  // Initialize the database
  initDatabase();

  // Mount the router
  app.use('/api/opal', router);

  console.log('[OPAL] Routes registered at /api/opal');
  console.log('[OPAL] Endpoints:');
  console.log('  POST   /api/opal/projects');
  console.log('  GET    /api/opal/projects');
  console.log('  GET    /api/opal/projects/:id');
  console.log('  GET    /api/opal/projects/:id/summary');
  console.log('  POST   /api/opal/projects/:id/covenant');
  console.log('  POST   /api/opal/projects/:id/stages/:stage/transition');
  console.log('  POST   /api/opal/projects/:id/advance');
  console.log('  GET    /api/opal/projects/:id/intake');
  console.log('  POST   /api/opal/projects/:id/intake');
  console.log('  POST   /api/opal/projects/:id/intake/batch');
  console.log('  GET    /api/opal/projects/:id/vault');
  console.log('  POST   /api/opal/projects/:id/vault');
  console.log('  POST   /api/opal/projects/:id/vault/:assetId/approve');
  console.log('  GET    /api/opal/projects/:id/approvals');
  console.log('  POST   /api/opal/projects/:id/approvals');
  console.log('  GET    /api/opal/stages');
}
