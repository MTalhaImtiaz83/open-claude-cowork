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
import { getAdaAgent } from './agents/ada-agent.js';
import { getLogoAgent } from './agents/logo-agent.js';
import { getCraftCriticAgent } from './agents/craft-critic.js';
import { parsePdf } from './parsers/pdf-parser.js';
import { parseDocx } from './parsers/docx-parser.js';
import { validateIntake, getIntakeSchema } from './parsers/intake-validator.js';
import { validateSvg, extractSvgFromText } from './parsers/svg-validator.js';
import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// --- ADA Agent Chat (Stage 1 Interview) ---

/**
 * POST /api/opal/projects/:id/agent/ada - SSE stream for ADA interview
 */
router.post('/projects/:id/agent/ada', async (req, res) => {
  const { message } = req.body;
  const projectId = req.params.id;

  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }

  console.log('[OPAL:ADA] Chat message for project:', projectId);

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeatInterval = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 15000);

  res.on('close', () => clearInterval(heartbeatInterval));

  try {
    const ada = getAdaAgent();
    let fullText = '';

    for await (const chunk of ada.run(projectId, message)) {
      if (chunk.type === 'text' && chunk.content) {
        fullText += chunk.content;
        res.write(`data: ${JSON.stringify({ type: 'text', content: chunk.content })}\n\n`);
      } else if (chunk.type === 'done') {
        // Parse intake_data blocks from the full response
        const intakeEntries = parseIntakeData(fullText);
        if (intakeEntries.length > 0) {
          for (const entry of intakeEntries) {
            setIntakeAnswer(projectId, entry.section, entry.key, entry.value);
          }
          res.write(`data: ${JSON.stringify({ type: 'intake_update', entries: intakeEntries })}\n\n`);
        }

        // Check gate status
        const gate = checkIntakeGate(projectId);
        res.write(`data: ${JSON.stringify({ type: 'gate_status', gate })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      }
    }
  } catch (error) {
    console.error('[OPAL:ADA] Error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
  } finally {
    clearInterval(heartbeatInterval);
    if (!res.writableEnded) res.end();
  }
});

/**
 * POST /api/opal/projects/:id/agent/ada/abort - Abort ADA agent
 */
router.post('/projects/:id/agent/ada/abort', (req, res) => {
  const ada = getAdaAgent();
  const aborted = ada.abort(req.params.id);
  res.json({ success: aborted });
});

/**
 * Parse intake_data code blocks from agent response text.
 * Format: ```intake_data\n{"section":"A","key":"A1","value":"..."}\n```
 */
function parseIntakeData(text) {
  const entries = [];
  const regex = /```intake_data\n([\s\S]*?)```/g;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const block = match[1].trim();
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.section && parsed.key && parsed.value !== undefined) {
          entries.push(parsed);
        }
      } catch (_) {
        console.warn('[OPAL:ADA] Failed to parse intake line:', trimmed);
      }
    }
  }

  return entries;
}

// --- File Upload (Stage 1 Branch A) ---

/**
 * POST /api/opal/projects/:id/intake/upload - Upload and parse a questionnaire document
 */
router.post('/projects/:id/intake/upload', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  const projectId = req.params.id;
  const contentType = req.headers['content-type'] || '';
  const filename = req.headers['x-filename'] || 'upload';

  console.log('[OPAL:Upload] File received for project:', projectId, 'type:', contentType);

  try {
    let text = '';

    if (contentType.includes('pdf') || filename.endsWith('.pdf')) {
      text = await parsePdf(req.body);
    } else if (contentType.includes('docx') || contentType.includes('officedocument') || filename.endsWith('.docx')) {
      text = await parseDocx(req.body);
    } else if (contentType.includes('text') || filename.endsWith('.txt')) {
      text = req.body.toString('utf-8');
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Please upload PDF, DOCX, or TXT.' });
    }

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: 'No text content could be extracted from the file.' });
    }

    console.log('[OPAL:Upload] Extracted text length:', text.length);

    // Use ADA agent to parse the document against the intake schema
    const ada = getAdaAgent();
    const parsePrompt = `I have received a completed Brand Intelligence Intake Questionnaire. Please analyze the following document text and extract all answers into the structured intake_data format. Map each answer to the correct section and key based on our intake schema.

Document content:
---
${text.substring(0, 15000)}
---

Extract ALL identifiable answers and output them in \`\`\`intake_data blocks. Be thorough — capture every piece of information that maps to our questionnaire sections (A through H).`;

    // Collect the full response
    let fullText = '';
    const chunks = [];

    for await (const chunk of ada.run(projectId, parsePrompt, { includeIntake: false })) {
      if (chunk.type === 'text' && chunk.content) {
        fullText += chunk.content;
        chunks.push(chunk.content);
      }
    }

    // Parse extracted data
    const entries = parseIntakeData(fullText);
    for (const entry of entries) {
      setIntakeAnswer(projectId, entry.section, entry.key, entry.value);
    }

    // Validate
    const validation = validateIntake(projectId);

    res.json({
      success: true,
      extractedText: text.substring(0, 500) + (text.length > 500 ? '...' : ''),
      entriesFound: entries.length,
      entries,
      validation,
    });
  } catch (error) {
    console.error('[OPAL:Upload] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- Logo Factory (Stage 2) ---

/**
 * GET /api/opal/projects/:id/logo/recipes - Get matching logo recipes based on brand archetype
 */
router.get('/projects/:id/logo/recipes', (req, res) => {
  try {
    const intake = getIntakeAnswers(req.params.id);
    const archetype = intake.B?.B2 || 'The Creator'; // Default archetype

    // Load all recipe files
    const recipesDir = path.join(__dirname, 'knowledge', 'logo-recipes');
    const files = fs.readdirSync(recipesDir).filter(f => f.endsWith('.yaml'));

    const allRecipes = files.map(f => {
      const content = fs.readFileSync(path.join(recipesDir, f), 'utf-8');
      return yaml.load(content);
    });

    // Find matching recipes (fuzzy match on archetype name)
    const archetypeLower = archetype.toLowerCase();
    const matched = allRecipes.filter(r =>
      archetypeLower.includes(r.archetype.toLowerCase().replace('the ', ''))
    );

    // If no exact match, return 2-3 closest + fallback
    const recipes = matched.length > 0 ? matched : allRecipes.slice(0, 3);

    res.json({
      brandArchetype: archetype,
      recipes,
      totalAvailable: allRecipes.length,
    });
  } catch (error) {
    console.error('[OPAL:Logo] Error loading recipes:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/opal/projects/:id/logo/generate - SSE stream for logo generation
 */
router.post('/projects/:id/logo/generate', async (req, res) => {
  const { recipe, customPrompt } = req.body;
  const projectId = req.params.id;

  console.log('[OPAL:Logo] Generating logo for project:', projectId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeatInterval = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 15000);

  res.on('close', () => clearInterval(heartbeatInterval));

  try {
    const intake = getIntakeAnswers(projectId);
    const brandName = intake.A?.A1 || 'Brand';
    const archetype = intake.B?.B2 || 'The Creator';

    let prompt = `Generate 2-3 SVG logomark variations for "${brandName}".

Brand Archetype: ${archetype}`;

    if (recipe) {
      prompt += `\n\nUse this recipe as guidance:\n${JSON.stringify(recipe, null, 2)}`;
    }

    if (customPrompt) {
      prompt += `\n\nAdditional instructions: ${customPrompt}`;
    }

    const logoAgent = getLogoAgent();
    let fullText = '';

    for await (const chunk of logoAgent.run(projectId, prompt)) {
      if (chunk.type === 'text' && chunk.content) {
        fullText += chunk.content;
        res.write(`data: ${JSON.stringify({ type: 'text', content: chunk.content })}\n\n`);
      } else if (chunk.type === 'done') {
        // Extract SVGs from the response
        const svgs = extractSvgFromText(fullText);
        const results = svgs.map((svg, i) => {
          const validation = validateSvg(svg);
          return { index: i, svg, validation };
        });

        // Save valid SVGs to vault
        for (const result of results) {
          if (result.validation.valid) {
            const filename = `logo-v${Date.now()}-${result.index}.svg`;
            const saved = saveAsset(projectId, 'logo', 2, filename, result.svg, {
              archetype,
              recipe: recipe?.name || 'custom',
              validation: result.validation,
            });
            result.assetId = saved.id;
          }
        }

        res.write(`data: ${JSON.stringify({ type: 'logos', results })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      }
    }
  } catch (error) {
    console.error('[OPAL:Logo] Error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
  } finally {
    clearInterval(heartbeatInterval);
    if (!res.writableEnded) res.end();
  }
});

/**
 * POST /api/opal/projects/:id/logo/critique - SSE stream for SVG critique
 */
router.post('/projects/:id/logo/critique', async (req, res) => {
  const { svgCode } = req.body;
  const projectId = req.params.id;

  if (!svgCode) {
    return res.status(400).json({ error: 'svgCode is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeatInterval = setInterval(() => {
    if (!res.writableEnded) res.write(': heartbeat\n\n');
  }, 15000);

  res.on('close', () => clearInterval(heartbeatInterval));

  try {
    const critic = getCraftCriticAgent();
    let fullText = '';

    for await (const chunk of critic.run(projectId, svgCode)) {
      if (chunk.type === 'text' && chunk.content) {
        fullText += chunk.content;
        res.write(`data: ${JSON.stringify({ type: 'text', content: chunk.content })}\n\n`);
      } else if (chunk.type === 'done') {
        // Try to parse craft_report from the response
        const reportMatch = fullText.match(/```craft_report\n([\s\S]*?)```/);
        let report = null;
        if (reportMatch) {
          try {
            report = JSON.parse(reportMatch[1].trim());
          } catch (_) { /* report parsing failed, that's ok */ }
        }

        res.write(`data: ${JSON.stringify({ type: 'critique', report })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      }
    }
  } catch (error) {
    console.error('[OPAL:Critic] Error:', error);
    res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
  } finally {
    clearInterval(heartbeatInterval);
    if (!res.writableEnded) res.end();
  }
});

/**
 * POST /api/opal/projects/:id/logo/validate - Programmatic SVG validation
 */
router.post('/projects/:id/logo/validate', (req, res) => {
  const { svgCode } = req.body;
  if (!svgCode) {
    return res.status(400).json({ error: 'svgCode is required' });
  }
  const result = validateSvg(svgCode);
  res.json(result);
});

// --- Intake Validation ---

/**
 * GET /api/opal/projects/:id/intake/validate - Run the quality gate check
 */
router.get('/projects/:id/intake/validate', (req, res) => {
  try {
    const validation = validateIntake(req.params.id);
    res.json(validation);
  } catch (error) {
    console.error('[OPAL:Validate] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/opal/intake-schema - Get the intake questionnaire schema
 */
router.get('/intake-schema', (_req, res) => {
  res.json(getIntakeSchema());
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
