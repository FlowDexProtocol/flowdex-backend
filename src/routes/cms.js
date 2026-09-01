// ══════════════════════════════════════════════════
// src/routes/cms.js
// Content Management System — lets the admin manage website content
// (banners, FAQs, blog, page copy, media, team) without code changes.
//
// Exports two routers:
//   cmsRoutes      — public, mounted at /api/cms      (no auth)
//   cmsAdminRoutes — admin,  mounted at /admin/cms     (adminAuth applied at mount in server.js)
// ══════════════════════════════════════════════════

const express = require('express');
const cmsRoutes = express.Router();
const cmsAdminRoutes = express.Router();
const pool = require('../db/pool');
const { logAudit } = require('../services/audit-service');

// ── Helpers ──

// Builds a `col1 = $1, col2 = $2` SET clause from whichever `allowedFields`
// are actually present on `body`, so partial updates don't clobber columns
// the caller didn't send.
function buildUpdateClause(body, allowedFields) {
  const sets = [];
  const params = [];
  let i = 1;
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      sets.push(`${field} = $${i++}`);
      params.push(body[field]);
    }
  }
  return { sets, params };
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function generateUniqueSlug(title) {
  const base = slugify(title) || 'post';
  let slug = base;
  let suffix = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await pool.query('SELECT id FROM cms_blog_posts WHERE slug = $1', [slug]);
    if (existing.rows.length === 0) return slug;
    slug = `${base}-${suffix++}`;
  }
}

// GET /api/cms/page/:page and GET /admin/cms/page/:page share this — returns
// an object keyed by "section.field".
async function getPageContent(page) {
  const result = await pool.query('SELECT section, field, value FROM cms_pages WHERE page = $1', [page]);
  const content = {};
  for (const row of result.rows) {
    content[`${row.section}.${row.field}`] = row.value;
  }
  return content;
}

// ══════════════════════════════════════════════════
// PUBLIC — /api/cms/*
// ══════════════════════════════════════════════════

// GET /api/cms/banners
cmsRoutes.get('/banners', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cms_banners WHERE is_active = true ORDER BY sort_order ASC, id ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/cms/faqs?category=
cmsRoutes.get('/faqs', async (req, res) => {
  try {
    const { category } = req.query;
    const params = [];
    let where = 'WHERE is_active = true';
    if (category) {
      params.push(category);
      where += ` AND category = $${params.length}`;
    }
    const result = await pool.query(`SELECT * FROM cms_faqs ${where} ORDER BY sort_order ASC, id ASC`, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/cms/blog?page=1&limit=10
cmsRoutes.get('/blog', async (req, res) => {
  try {
    let page = parseInt(req.query.page, 10);
    if (!Number.isFinite(page) || page < 1) page = 1;
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 10;
    limit = Math.min(limit, 50);
    const offset = (page - 1) * limit;

    const totalResult = await pool.query('SELECT COUNT(*) as t FROM cms_blog_posts WHERE is_published = true');
    const total = parseInt(totalResult.rows[0].t, 10);

    const result = await pool.query(
      `SELECT id, title, slug, excerpt, cover_image_url, category, author, published_at, created_at
       FROM cms_blog_posts WHERE is_published = true
       ORDER BY published_at DESC NULLS LAST
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    res.json({
      posts: result.rows,
      page,
      limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/cms/blog/:slug
cmsRoutes.get('/blog/:slug', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cms_blog_posts WHERE slug = $1 AND is_published = true', [req.params.slug]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Post not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/cms/page/:page
cmsRoutes.get('/page/:page', async (req, res) => {
  try {
    res.json(await getPageContent(req.params.page));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/cms/media?category=press
cmsRoutes.get('/media', async (req, res) => {
  try {
    const { category } = req.query;
    const params = [];
    let where = 'WHERE is_active = true';
    if (category) {
      params.push(category);
      where += ` AND category = $${params.length}`;
    }
    const result = await pool.query(`SELECT * FROM cms_media ${where} ORDER BY sort_order ASC, id ASC`, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/cms/team
cmsRoutes.get('/team', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cms_team WHERE is_active = true ORDER BY sort_order ASC, id ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ══════════════════════════════════════════════════
// ADMIN — /admin/cms/* (adminAuth already applied at mount — req.admin is available)
// ══════════════════════════════════════════════════

// ── Banners ──

// GET /admin/cms/banners — all banners, including inactive (unlike the
// public list, which only returns is_active = true)
cmsAdminRoutes.get('/banners', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cms_banners ORDER BY sort_order ASC, id ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.post('/banners', async (req, res) => {
  try {
    const { title, subtitle, cta_text, cta_link, image_url, bg_style, sort_order, is_active } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'title is required' });

    const result = await pool.query(
      `INSERT INTO cms_banners (title, subtitle, cta_text, cta_link, image_url, bg_style, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'gradient'),COALESCE($7,0),COALESCE($8,true))
       RETURNING *`,
      [title, subtitle || null, cta_text || null, cta_link || null, image_url || null, bg_style, sort_order, is_active]
    );
    const banner = result.rows[0];
    await logAudit('cms_banner_created', null, null, null, null, banner, 'CMS banner created', req.admin.username, req.ip);
    res.json({ success: true, banner });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.put('/banners/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM cms_banners WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'Banner not found' });

    const allowed = ['title', 'subtitle', 'cta_text', 'cta_link', 'image_url', 'bg_style', 'sort_order', 'is_active'];
    const { sets, params } = buildUpdateClause(req.body, allowed);
    if (sets.length === 0) return res.status(400).json({ success: false, error: 'No valid fields to update' });

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE cms_banners SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
      params
    );
    const banner = result.rows[0];
    await logAudit('cms_banner_updated', null, null, null, existing.rows[0], banner, 'CMS banner updated', req.admin.username, req.ip);
    res.json({ success: true, banner });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.delete('/banners/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM cms_banners WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'Banner not found' });

    await pool.query('DELETE FROM cms_banners WHERE id = $1', [req.params.id]);
    await logAudit('cms_banner_deleted', null, null, null, existing.rows[0], null, 'CMS banner deleted', req.admin.username, req.ip);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.post('/banners/reorder', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false, error: 'ids array is required' });

    for (let i = 0; i < ids.length; i++) {
      await pool.query('UPDATE cms_banners SET sort_order = $1, updated_at = NOW() WHERE id = $2', [i, ids[i]]);
    }
    await logAudit('cms_banner_reordered', null, null, null, null, { ids }, 'CMS banners reordered', req.admin.username, req.ip);
    res.json({ success: true, order: ids });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── FAQs ──

// GET /admin/cms/faqs — all FAQs, including inactive
cmsAdminRoutes.get('/faqs', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cms_faqs ORDER BY sort_order ASC, id ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.post('/faqs', async (req, res) => {
  try {
    const { question, answer, category, sort_order, is_active } = req.body;
    if (!question || !answer) return res.status(400).json({ success: false, error: 'question and answer are required' });

    const result = await pool.query(
      `INSERT INTO cms_faqs (question, answer, category, sort_order, is_active)
       VALUES ($1,$2,COALESCE($3,'general'),COALESCE($4,0),COALESCE($5,true))
       RETURNING *`,
      [question, answer, category, sort_order, is_active]
    );
    const faq = result.rows[0];
    await logAudit('cms_faq_created', null, null, null, null, faq, 'CMS FAQ created', req.admin.username, req.ip);
    res.json({ success: true, faq });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.put('/faqs/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM cms_faqs WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'FAQ not found' });

    const allowed = ['question', 'answer', 'category', 'sort_order', 'is_active'];
    const { sets, params } = buildUpdateClause(req.body, allowed);
    if (sets.length === 0) return res.status(400).json({ success: false, error: 'No valid fields to update' });

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE cms_faqs SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
      params
    );
    const faq = result.rows[0];
    await logAudit('cms_faq_updated', null, null, null, existing.rows[0], faq, 'CMS FAQ updated', req.admin.username, req.ip);
    res.json({ success: true, faq });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.delete('/faqs/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM cms_faqs WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'FAQ not found' });

    await pool.query('DELETE FROM cms_faqs WHERE id = $1', [req.params.id]);
    await logAudit('cms_faq_deleted', null, null, null, existing.rows[0], null, 'CMS FAQ deleted', req.admin.username, req.ip);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.post('/faqs/reorder', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false, error: 'ids array is required' });

    for (let i = 0; i < ids.length; i++) {
      await pool.query('UPDATE cms_faqs SET sort_order = $1, updated_at = NOW() WHERE id = $2', [i, ids[i]]);
    }
    await logAudit('cms_faq_reordered', null, null, null, null, { ids }, 'CMS FAQs reordered', req.admin.username, req.ip);
    res.json({ success: true, order: ids });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Blog ──

// GET /admin/cms/blog — all posts, published or not, full rows (including
// content) so the editor can populate directly from the list
cmsAdminRoutes.get('/blog', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cms_blog_posts ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.post('/blog', async (req, res) => {
  try {
    const { title, excerpt, content, cover_image_url, category, author, is_published } = req.body;
    if (!title || !content) return res.status(400).json({ success: false, error: 'title and content are required' });

    const slug = await generateUniqueSlug(title);
    const publishNow = is_published === true;

    const result = await pool.query(
      `INSERT INTO cms_blog_posts (title, slug, excerpt, content, cover_image_url, category, author, is_published, published_at)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'updates'),COALESCE($7,'FlowDex Team'),$8,$9)
       RETURNING *`,
      [title, slug, excerpt || null, content, cover_image_url || null, category, author, publishNow, publishNow ? new Date() : null]
    );
    const post = result.rows[0];
    await logAudit('cms_blog_created', null, null, null, null, post, 'CMS blog post created', req.admin.username, req.ip);
    res.json({ success: true, post });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.put('/blog/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM cms_blog_posts WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'Post not found' });
    const current = existing.rows[0];

    if (req.body.slug && req.body.slug !== current.slug) {
      const clash = await pool.query('SELECT id FROM cms_blog_posts WHERE slug = $1 AND id != $2', [req.body.slug, req.params.id]);
      if (clash.rows.length > 0) return res.status(400).json({ success: false, error: 'Slug already in use' });
    }

    const allowed = ['title', 'slug', 'excerpt', 'content', 'cover_image_url', 'category', 'author', 'is_published'];
    const { sets, params } = buildUpdateClause(req.body, allowed);
    if (sets.length === 0) return res.status(400).json({ success: false, error: 'No valid fields to update' });

    if (req.body.is_published === true && !current.published_at) {
      sets.push('published_at = NOW()');
    }

    params.push(req.params.id);
    const result = await pool.query(
      `UPDATE cms_blog_posts SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING *`,
      params
    );
    const post = result.rows[0];
    await logAudit('cms_blog_updated', null, null, null, current, post, 'CMS blog post updated', req.admin.username, req.ip);
    res.json({ success: true, post });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.delete('/blog/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM cms_blog_posts WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'Post not found' });

    await pool.query('DELETE FROM cms_blog_posts WHERE id = $1', [req.params.id]);
    await logAudit('cms_blog_deleted', null, null, null, existing.rows[0], null, 'CMS blog post deleted', req.admin.username, req.ip);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.post('/blog/:id/publish', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE cms_blog_posts SET is_published = true, published_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Post not found' });

    const post = result.rows[0];
    await logAudit('cms_blog_published', null, null, null, null, { id: post.id, slug: post.slug }, 'CMS blog post published', req.admin.username, req.ip);
    res.json({ success: true, post });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.post('/blog/:id/unpublish', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE cms_blog_posts SET is_published = false, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, error: 'Post not found' });

    const post = result.rows[0];
    await logAudit('cms_blog_unpublished', null, null, null, null, { id: post.id, slug: post.slug }, 'CMS blog post unpublished', req.admin.username, req.ip);
    res.json({ success: true, post });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Page content ──

cmsAdminRoutes.put('/page/:page/:section/:field', async (req, res) => {
  try {
    const { value } = req.body;
    if (value === undefined || value === null) return res.status(400).json({ success: false, error: 'value is required' });
    const { page, section, field } = req.params;

    const existing = await pool.query('SELECT * FROM cms_pages WHERE page=$1 AND section=$2 AND field=$3', [page, section, field]);

    const result = await pool.query(
      `INSERT INTO cms_pages (page, section, field, value, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (page, section, field) DO UPDATE SET value = $4, updated_at = NOW()
       RETURNING *`,
      [page, section, field, String(value)]
    );

    await logAudit(
      'cms_page_updated', null, null, null,
      existing.rows[0] || null, result.rows[0],
      `CMS page content updated: ${page}.${section}.${field}`, req.admin.username, req.ip
    );
    res.json({ success: true, content: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.get('/page/:page', async (req, res) => {
  try {
    res.json(await getPageContent(req.params.page));
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Media ──

// GET /admin/cms/media — all media, including inactive
cmsAdminRoutes.get('/media', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cms_media ORDER BY sort_order ASC, id ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.post('/media', async (req, res) => {
  try {
    const { name, type, url, alt_text, category, sort_order, is_active } = req.body;
    if (!name || !type || !url) return res.status(400).json({ success: false, error: 'name, type, and url are required' });

    const result = await pool.query(
      `INSERT INTO cms_media (name, type, url, alt_text, category, sort_order, is_active)
       VALUES ($1,$2,$3,$4,COALESCE($5,'general'),COALESCE($6,0),COALESCE($7,true))
       RETURNING *`,
      [name, type, url, alt_text || null, category, sort_order, is_active]
    );
    const media = result.rows[0];
    await logAudit('cms_media_created', null, null, null, null, media, 'CMS media created', req.admin.username, req.ip);
    res.json({ success: true, media });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.delete('/media/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM cms_media WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'Media not found' });

    await pool.query('DELETE FROM cms_media WHERE id = $1', [req.params.id]);
    await logAudit('cms_media_deleted', null, null, null, existing.rows[0], null, 'CMS media deleted', req.admin.username, req.ip);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Team ──

// GET /admin/cms/team — all team members, including inactive
cmsAdminRoutes.get('/team', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM cms_team ORDER BY sort_order ASC, id ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.post('/team', async (req, res) => {
  try {
    const { name, role, bio, photo_url, linkedin_url, sort_order, is_active } = req.body;
    if (!name || !role) return res.status(400).json({ success: false, error: 'name and role are required' });

    const result = await pool.query(
      `INSERT INTO cms_team (name, role, bio, photo_url, linkedin_url, sort_order, is_active)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,0),COALESCE($7,true))
       RETURNING *`,
      [name, role, bio || null, photo_url || null, linkedin_url || null, sort_order, is_active]
    );
    const member = result.rows[0];
    await logAudit('cms_team_created', null, null, null, null, member, 'CMS team member created', req.admin.username, req.ip);
    res.json({ success: true, member });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.put('/team/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM cms_team WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'Team member not found' });

    const allowed = ['name', 'role', 'bio', 'photo_url', 'linkedin_url', 'sort_order', 'is_active'];
    const { sets, params } = buildUpdateClause(req.body, allowed);
    if (sets.length === 0) return res.status(400).json({ success: false, error: 'No valid fields to update' });

    params.push(req.params.id);
    const result = await pool.query(`UPDATE cms_team SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    const member = result.rows[0];
    await logAudit('cms_team_updated', null, null, null, existing.rows[0], member, 'CMS team member updated', req.admin.username, req.ip);
    res.json({ success: true, member });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.delete('/team/:id', async (req, res) => {
  try {
    const existing = await pool.query('SELECT * FROM cms_team WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ success: false, error: 'Team member not found' });

    await pool.query('DELETE FROM cms_team WHERE id = $1', [req.params.id]);
    await logAudit('cms_team_deleted', null, null, null, existing.rows[0], null, 'CMS team member deleted', req.admin.username, req.ip);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

cmsAdminRoutes.post('/team/reorder', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ success: false, error: 'ids array is required' });

    for (let i = 0; i < ids.length; i++) {
      await pool.query('UPDATE cms_team SET sort_order = $1 WHERE id = $2', [i, ids[i]]);
    }
    await logAudit('cms_team_reordered', null, null, null, null, { ids }, 'CMS team reordered', req.admin.username, req.ip);
    res.json({ success: true, order: ids });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = { cmsRoutes, cmsAdminRoutes };
