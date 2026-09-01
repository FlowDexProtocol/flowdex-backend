require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const banners = [
  {
    title: 'FlowDex Protocol Presale is Live',
    subtitle: 'Get in early on $FDP before listing at the lowest price it will ever be.',
    cta_text: 'Buy $FDP',
    cta_link: '/#buy',
    bg_style: 'gradient',
    sort_order: 0,
  },
  {
    title: 'Earn a 15% Referral Bonus',
    subtitle:
      'Share your link — you earn 15% of what your friend spends, and they get a 30% bonus on their purchase. Both split 70% Terminal Credits + 30% $FDP.',
    cta_text: 'Get Your Referral Link',
    cta_link: '/#referral',
    bg_style: 'gradient-purple',
    sort_order: 1,
  },
  {
    title: 'Staking Launches in Phase 3',
    subtitle: 'Stake $FDP to earn 40% of protocol fees from every trade — crypto, stocks, forex, and commodities.',
    cta_text: 'Learn More',
    cta_link: '/#staking',
    bg_style: 'gradient-cyan',
    sort_order: 2,
  },
];

const faqs = [
  {
    question: 'What is FlowDex Protocol?',
    answer:
      'FlowDex Protocol unifies crypto, stocks, forex, and commodities into a single intelligent trading layer. $FDP is the token that powers the network — securing routing, governance, and fee-sharing across every market it supports.',
    category: 'general',
    sort_order: 0,
  },
  {
    question: 'What is $FDP used for?',
    answer:
      'Holding and staking $FDP unlocks trading fee discounts, a share of protocol fees once staking opens in Phase 3, governance voting rights, and priority order routing across the platform.',
    category: 'general',
    sort_order: 1,
  },
  {
    question: 'How do I participate in the presale?',
    answer:
      'Connect your wallet, choose a payment method (ETH, USDT, USDC, BNB, SOL, or BTC), enter the USD amount you want to spend, and confirm your purchase. You will receive a deposit address and your price is locked for 15 minutes.',
    category: 'presale',
    sort_order: 0,
  },
  {
    question: 'What payment methods are accepted?',
    answer: 'ETH, USDT (ERC-20 or TRC-20), USDC, BNB, SOL, and BTC are all accepted during the presale.',
    category: 'presale',
    sort_order: 1,
  },
  {
    question: 'What is the token vesting schedule?',
    answer:
      'Each presale tier has its own TGE unlock percentage, cliff period, and vesting length — earlier tiers generally vest over a longer period, later tiers unlock faster. The exact terms for the tier you buy into are shown on the buy page at the time of purchase.',
    category: 'tokenomics',
    sort_order: 0,
  },
  {
    question: 'When can I claim my tokens?',
    answer:
      'Claims open once a tier reaches Token Generation Event (TGE). Your TGE percentage unlocks immediately, with the remainder released according to that tier’s cliff and vesting schedule. You can check and claim available tokens any time from your dashboard.',
    category: 'tokenomics',
    sort_order: 1,
  },
  {
    question: 'How does the referral program work?',
    answer:
      'Every wallet gets a unique referral code as soon as it connects. Share your link — when someone buys using your code, you earn 15% of what they spend and they get a 30% bonus on their own purchase. Both bonuses split 70% Terminal Credits and 30% $FDP tokens, tracked in your Referral dashboard.',
    category: 'referral',
    sort_order: 0,
  },
  {
    question: 'Is my purchase secure?',
    answer:
      'Payments go directly to protocol-controlled deposit addresses and every purchase is matched against on-chain activity through an automated reconciliation process. Your funds are never routed through a third party during the presale.',
    category: 'security',
    sort_order: 0,
  },
];

// page → section → field → value
const pageContent = {
  landing: {
    hero: {
      title: 'Trade Everything. Know Everything.',
      subtitle:
        'FlowDex Protocol unifies crypto, stocks, forex, and commodities into a single intelligent trading layer. $FDP powers the network.',
    },
    ecosystem: {
      title: 'One Protocol. Every Market.',
      description:
        'FlowDex routes orders across crypto, equities, forex, and commodities from a single account, giving traders one interface instead of a dozen disconnected platforms.',
    },
    utility: {
      title: '$FDP Utility',
      description:
        'Holding and staking $FDP unlocks trading fee discounts, a share of protocol fees, governance voting, and priority order routing.',
    },
    staking: {
      title: 'Stake $FDP',
      description:
        'Stake $FDP to earn 40% of protocol fees from every trade - crypto, stocks, forex, commodities, and more. Governance voting and routing priority included. In Phase 3, stakers become FlowChain validators.',
    },
  },
};

async function seedBanners() {
  const existing = await pool.query('SELECT COUNT(*) as t FROM cms_banners');
  if (parseInt(existing.rows[0].t, 10) > 0) {
    console.log('cms_banners already seeded — skipping');
    return;
  }
  for (const b of banners) {
    await pool.query(
      `INSERT INTO cms_banners (title, subtitle, cta_text, cta_link, bg_style, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [b.title, b.subtitle, b.cta_text, b.cta_link, b.bg_style, b.sort_order]
    );
  }
  console.log(`Seeded ${banners.length} banners`);
}

async function seedFaqs() {
  const existing = await pool.query('SELECT COUNT(*) as t FROM cms_faqs');
  if (parseInt(existing.rows[0].t, 10) > 0) {
    console.log('cms_faqs already seeded — skipping');
    return;
  }
  for (const f of faqs) {
    await pool.query(
      `INSERT INTO cms_faqs (question, answer, category, sort_order)
       VALUES ($1,$2,$3,$4)`,
      [f.question, f.answer, f.category, f.sort_order]
    );
  }
  console.log(`Seeded ${faqs.length} FAQs`);
}

async function seedPageContent() {
  let count = 0;
  for (const [page, sections] of Object.entries(pageContent)) {
    for (const [section, fields] of Object.entries(sections)) {
      for (const [field, value] of Object.entries(fields)) {
        await pool.query(
          `INSERT INTO cms_pages (page, section, field, value, updated_at)
           VALUES ($1,$2,$3,$4,NOW())
           ON CONFLICT (page, section, field) DO UPDATE SET value = $4, updated_at = NOW()`,
          [page, section, field, value]
        );
        count++;
      }
    }
  }
  console.log(`Seeded ${count} page content fields`);
}

async function seed() {
  try {
    await seedBanners();
    await seedFaqs();
    await seedPageContent();
    console.log('CMS seed complete');
  } catch (err) {
    console.error('CMS seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seed();
