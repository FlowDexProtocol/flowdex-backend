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

  // ── Landing page (page = 'home') ──
  home: {
    hero: {
      badge_text: 'Presale Live',
      headline_1: 'Trade Everything.',
      headline_2: 'Know Everything.',
      subtitle:
        'FlowDex Protocol unifies crypto, stocks, forex, and commodities into a single intelligent trading layer. $FDP powers fee sharing, governance, and AI-driven market intelligence.',
      cta_primary_text: 'Buy $FDP',
      cta_primary_link: 'https://purchase.flowdexprotocol.com',
      cta_secondary_text: 'Read Whitepaper',
      cta_secondary_link: '/whitepaper',
      trust_1: 'Audit in Progress',
      trust_2: 'Community Growing',
      trust_3: '6 Chains',
    },
    presale_card: {
      label: 'Stage 1: Genesis',
      tokens_accepted: 'ETH · USDT · USDC · BNB · SOL · BTC · TRX',
    },
    metrics: {
      label_1: 'Total Raised',
      label_2: 'Current Price',
      label_3: 'Listing Price',
      label_4: 'ROI at Listing',
    },
    ecosystem: {
      title: 'The FlowDex Ecosystem',
      subtitle: 'A complete DeFi infrastructure for the next generation of finance.',
    },
    ecosystem_1: {
      title: 'Universal Exchange',
      description:
        'Trade crypto, stocks, forex, and commodities from one interface. Cross-chain routing scans every DEX and liquidity source to find the best price. One platform for every market.',
      tags: 'Cross-Chain,Multi-Asset,Best Price',
      image_url: '',
    },
    ecosystem_2: {
      title: 'Blockchain Intelligence Terminal',
      description:
        'AI-powered market intelligence. Real-time whale tracking, pattern detection, predictive analytics, and smart alerts — all derived from live on-chain data.',
      tags: 'AI-Powered,Whale Tracking,Real-Time',
      image_url: '',
    },
    ecosystem_3: {
      title: 'FlowChain — Layer 1 Blockchain',
      description:
        'Our own Layer 1 blockchain launching in Phase 3. Purpose-built for high-frequency trading and cross-chain settlement. $FDP holders become validators.',
      tags: 'Layer 1,Validators,Phase 3',
      image_url: '',
    },
    ecosystem_4: {
      title: 'Staking & 40% Fee Sharing',
      description:
        'Stake $FDP to earn 40% of all protocol trading fees. Every trade across every market generates revenue that flows to stakers. Governance voting included.',
      tags: '40% Fees,Governance,Passive Income',
      image_url: '',
    },
    ecosystem_5: {
      title: 'Smart Order Routing',
      description:
        'Our routing engine compares prices across 100+ DEXs and liquidity pools in real-time. Every trade gets the best execution with the lowest slippage and fees.',
      tags: '100+ DEXs,Low Slippage,Auto-Route',
      image_url: '',
    },
    ecosystem_6: {
      title: 'Unified Portfolio',
      description:
        'Track all your holdings across every chain in one dashboard. Real-time P&L, historical performance, and automated alerts on your positions.',
      tags: 'Multi-Chain,Real-Time P&L,Alerts',
      image_url: '',
    },
    utility: {
      title: '$FDP Powers Everything',
      subtitle: 'Five utilities. One token. Real value from day one.',
    },
    utility_1: {
      title: '40% Fee Sharing',
      description:
        'Stake $FDP to earn 40% of all trading fees. Every trade across crypto, stocks, forex, and commodities generates revenue for stakers.',
    },
    utility_2: {
      title: 'Governance Voting',
      description: 'Vote on protocol upgrades, fee structures, new asset listings, and treasury allocation. Your tokens, your voice.',
    },
    utility_3: {
      title: 'Routing Priority',
      description: '$FDP holders get priority order routing and reduced slippage on every trade. Better execution, every time.',
    },
    utility_4: {
      title: 'Validator Staking',
      description: 'In Phase 3, stake $FDP to become a FlowChain validator. Secure the network and earn additional rewards.',
    },
    utility_5: {
      title: 'Intelligence Access',
      description:
        'Unlock the full Intelligence Terminal with AI analytics, whale alerts, predictive signals, and on-chain data tools.',
    },
    utility_6: {
      title: 'Deflationary Supply 🔥',
      description:
        'Every referral purchase permanently burns $FDP from the supply. The more the community grows, the scarcer $FDP becomes.',
    },
    scenarios: {
      title: 'What Could Your $FDP Be Worth?',
      subtitle: 'Based on a $500 investment at Genesis price. For illustration only.',
      disclaimer: 'These projections are illustrative only and are not a guarantee of future performance.',
    },
    referral: {
      title: 'Earn 15% When You Refer',
      subtitle: 'Your friends earn 30% bonus too. Everyone wins.',
      step_1: 'Connect your wallet on the buy page to get your unique referral link',
      step_2: 'Share your link on social media, DMs, or anywhere',
      step_3: 'When someone buys using your link, you both earn bonuses',
      step_4: 'You earn 15% of what your friend spends — split 70% Terminal Credits + 30% $FDP',
      step_5: 'Your friend earns 30% bonus on their purchase',
      burn_title: 'Deflationary by Design',
      burn_description:
        'Every referral purchase burns tokens permanently 🔥. When your friend buys using your code, bonus tokens are created for both of you — and an equal amount is burned from the supply at full tier price. More referrals = more burns = less supply = more value for holders.',
    },
    cta: {
      title: "Don't Miss the Lowest Price",
      subtitle: 'Tier 1 won\'t last forever. Every tier costs more.',
      button_text: 'Buy $FDP Now',
      subscribe_placeholder: 'your@email.com',
    },
    vesting: {
      label: 'Presale Vesting',
      description: 'Each tier has different vesting terms. Earlier tiers have longer vesting but the lowest price.',
    },
  },

  // ── Site-wide settings (page = 'global') ──
  global: {
    support: {
      email: 'support@flowdexprotocol.com',
      telegram: 'https://t.me/flowdexprotocol',
    },
    logo: {
      type: 'text',
      text_main: 'Flow',
      text_accent: 'Dex',
      image_url: '',
    },
    site: {
      name: 'FlowDex Protocol',
      tagline: 'Trade Everything. Know Everything.',
      support_email: 'support@flowdexprotocol.com',
    },
    social: {
      twitter: 'https://x.com/flowdexprotocol',
      telegram: 'https://t.me/flowdexprotocol',
      discord: 'https://discord.gg/flowdexprotocol',
    },
    footer: {
      disclaimer:
        'This is not financial advice. $FDP is a utility token. Cryptocurrency purchases carry risk, including total loss of funds.',
      copyright: '© 2026 FlowDex Protocol. All rights reserved.',
    },
  },

  // ── Navigation (page = 'nav') ──
  nav: {
    header: {
      link_1_text: 'Home',
      link_1_url: '/',
      link_2_text: 'About',
      link_2_url: '/#ecosystem',
      link_3_text: 'Tokenomics',
      link_3_url: '/tokenomics',
      link_4_text: 'Roadmap',
      link_4_url: '/roadmap',
      link_5_text: 'Whitepaper',
      link_5_url: '/whitepaper',
      link_6_text: 'FAQ',
      link_6_url: '/faq',
      link_7_text: 'Blog',
      link_7_url: '/blogs',
      buy_button_text: 'Buy $FDP',
      buy_button_url: 'https://purchase.flowdexprotocol.com',
    },
  },

  // ── Tokenomics page (page = 'tokenomics') ──
  tokenomics: {
    hero: {
      title: 'Tokenomics',
      subtitle: '10,000,000,000 $FDP — fixed supply, no inflation',
    },
    distribution: {
      presale: '22.5',
      liquidity: '20',
      team: '15',
      ecosystem: '15',
      marketing: '10',
      staking: '10',
      reserve: '7.5',
    },
  },

  // ── Roadmap page (page = 'roadmap') ──
  roadmap: {
    phase_1: {
      title: 'Foundation',
      timeline: 'Q3-Q4 2026',
      status: 'active',
      items: 'Presale launch,Smart contract audit,Community building,Exchange listing preparation',
    },
    phase_2: {
      title: 'Exchange Launch',
      timeline: 'Q1-Q2 2027',
      status: 'upcoming',
      items: 'Universal Exchange beta,Cross-chain routing,DEX aggregation live,Token Generation Event',
    },
    phase_3: {
      title: 'Intelligence',
      timeline: 'Q3-Q4 2027',
      status: 'planned',
      items: 'Intelligence Terminal launch,AI analytics engine,Whale tracking,Staking launch',
    },
    phase_4: {
      title: 'FlowChain',
      timeline: '2028+',
      status: 'future',
      items: 'FlowChain L1 launch,Validator network,Full ecosystem deployment',
    },
  },

  // ── Legal pages ──
  terms: {
    content: {
      body: '[Full terms of service text — placeholder for admin to fill in]',
    },
  },
  privacy: {
    content: {
      body: '[Full privacy policy text — placeholder for admin to fill in]',
    },
  },
  legal: {
    content: {
      body: '[Full legal notice text — placeholder for admin to fill in]',
    },
  },

  // ── Buy page (page = 'buy') ──
  buy: {
    hero: {
      badge: 'Presale Live',
      headline_1: 'Trade Everything.',
      headline_2: 'Know Everything.',
    },
    form: {
      title: 'Buy $FDP',
      subtitle: 'Lock in your price for 15 minutes and receive a deposit address.',
      gas_warning_native: 'Note: Network gas fees of approximately $2-15 apply on top of this amount.',
      gas_warning_token: 'Note: A small network fee applies for token transfers.',
    },
    vesting: {
      title: 'Your Vesting Schedule',
    },
    referral: {
      title: 'Referral Code (optional)',
    },
    support: {
      text: 'Need help? Contact support@flowdexprotocol.com',
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
  // DO NOTHING (not DO UPDATE) — this script is re-run on every deploy, and
  // an admin may have already edited a field via the CMS dashboard by then.
  // Re-seeding must never clobber a live edit; it only fills in fields that
  // don't exist yet.
  let inserted = 0;
  let skipped = 0;
  for (const [page, sections] of Object.entries(pageContent)) {
    for (const [section, fields] of Object.entries(sections)) {
      for (const [field, value] of Object.entries(fields)) {
        const result = await pool.query(
          `INSERT INTO cms_pages (page, section, field, value, updated_at)
           VALUES ($1,$2,$3,$4,NOW())
           ON CONFLICT (page, section, field) DO NOTHING
           RETURNING id`,
          [page, section, field, value]
        );
        if (result.rows.length > 0) inserted++;
        else skipped++;
      }
    }
  }
  console.log(`Page content: ${inserted} fields inserted, ${skipped} already existed and were left untouched`);
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
