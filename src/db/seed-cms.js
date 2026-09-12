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

const blogPosts = [
  {
    title: 'Introducing FlowDex Protocol',
    slug: 'introducing-flowdex-protocol',
    excerpt: 'FlowDex Protocol unifies crypto, stocks, forex, and commodities into a single intelligent trading layer.',
    content: `FlowDex Protocol is building a new kind of DeFi platform — one that combines a Universal Exchange with a Blockchain Intelligence Terminal, all powered by the $FDP token.

The Universal Exchange lets you trade crypto, stocks, forex, and commodities from a single interface. Our cross-chain routing engine scans every DEX and liquidity pool to find the best price, so you never miss an opportunity.

The Intelligence Terminal provides AI-powered market analytics. Real-time whale tracking, pattern detection, predictive signals, and smart alerts — all derived from live on-chain data.

$FDP is the token that powers everything. Holders earn 40% of all protocol trading fees through staking, vote on governance decisions, get priority order routing, and access premium intelligence features.

The presale is live now with 8 tiers. Tier 1 (Genesis) offers $FDP at $0.001 — a 98% discount from the $0.05 listing price. Earlier tiers get the best price but have longer vesting periods.

Visit purchase.flowdexprotocol.com to participate.`,
    category: 'announcements',
    author: 'FlowDex Team',
  },
  {
    title: 'How to Buy $FDP — Step by Step',
    slug: 'how-to-buy-fdp-guide',
    excerpt: 'A complete guide to buying $FDP tokens in the FlowDex presale. No experience needed.',
    content: `Buying $FDP is straightforward. Here is everything you need to know.

Step 1: Get a Wallet. Download MetaMask (metamask.io) or Trust Wallet from your app store. Create a new wallet and save your recovery phrase somewhere safe.

Step 2: Add Funds. Buy ETH, USDT, or BNB from any exchange (Coinbase, Binance, etc.) and send it to your wallet address.

Step 3: Visit the Buy Page. Go to purchase.flowdexprotocol.com and click Connect Wallet. Select your wallet and approve the connection.

Step 4: Choose Payment. Select which crypto you want to pay with — ETH, USDT, USDC, BNB, SOL, or BTC. Enter the USD amount you want to spend.

Step 5: Confirm and Send. Click Buy $FDP. You will receive a deposit address with a QR code and a 15-minute price lock. Send the exact amount shown to the address provided.

Step 6: Check Your Portfolio. Once your payment is confirmed on the blockchain, your $FDP tokens are allocated automatically. Check the Portfolio tab to see your holdings and vesting schedule.

Need help? Contact support@flowdexprotocol.com`,
    category: 'updates',
    author: 'FlowDex Team',
  },
  {
    title: 'Understanding $FDP Tokenomics',
    slug: 'understanding-fdp-tokenomics',
    excerpt: 'A deep dive into the $FDP token distribution, vesting schedule, and deflationary burn mechanism.',
    content: `$FDP has a fixed total supply of 10 billion tokens. No inflation, no additional minting.

The supply is allocated across seven categories: Presale (22.5%), Liquidity (20%), Team and Advisors (15%, with 2-year vest and 6-month cliff), Ecosystem Fund (15%), Marketing (10%), Staking Rewards (10%), and Reserve (7.5%).

Each presale tier has its own vesting terms. Tier 1 (Genesis) at $0.001 gets 5% at TGE with a 12-month cliff and 24-month vest. Tier 8 (Launch) at $0.05 gets 100% at TGE with no cliff or vest. Earlier tiers get better prices but longer lockups. Later tiers cost more but tokens unlock faster.

The referral program adds a deflationary mechanism. Every referral purchase burns bonus tokens permanently from the supply. When someone buys using a referral code, both the referrer and the buyer receive bonus tokens — and an equal amount of $FDP is burned at full tier price. More referrals mean more burns and a shrinking supply.

Terminal Credits, earned through referrals, are redeemable when the Blockchain Intelligence Terminal launches. Credits are split 70/30 — 70% Terminal Credits and 30% $FDP tokens.

View the full breakdown at flowdexprotocol.com/tokenomics`,
    category: 'research',
    author: 'FlowDex Team',
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
      link_2_url: '/about',
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
      body: `TERMS OF SERVICE — Last Updated: September 2026

1. ACCEPTANCE OF TERMS
By accessing or using the FlowDex Protocol platform, purchasing $FDP tokens, or interacting with any FlowDex smart contracts, you agree to be bound by these Terms of Service.

2. TOKEN PURCHASE
$FDP is a utility token. Purchasing $FDP does not constitute an investment in a security. $FDP tokens provide access to platform features including fee sharing, governance, routing priority, validator staking, and intelligence terminal access.

3. ELIGIBILITY
You must be at least 18 years old and legally able to enter into contracts in your jurisdiction. You are responsible for ensuring compliance with your local laws. FlowDex does not perform KYC verification.

4. PRESALE TERMS
Token prices are set per tier and locked for 15 minutes upon creating a purchase intent. Tokens are allocated at the locked price regardless of market fluctuations. Vesting schedules vary by tier.

5. RISKS
Cryptocurrency purchases carry significant risk including total loss of funds. Token prices can fluctuate. Past performance does not indicate future results. You should only purchase what you can afford to lose.

6. REFUND POLICY
All purchases are final. Blockchain transactions cannot be reversed. No refunds will be issued.

7. INTELLECTUAL PROPERTY
All content, branding, and technology are the property of FlowDex Protocol.

8. LIMITATION OF LIABILITY
FlowDex Protocol shall not be liable for any losses arising from market volatility, smart contract vulnerabilities, regulatory changes, or third-party services.

9. MODIFICATIONS
We may update these terms at any time. Continued use constitutes acceptance of updated terms.

10. GOVERNING LAW
These terms are governed by applicable laws of the jurisdiction in which FlowDex Protocol is registered.`,
    },
  },
  privacy: {
    content: {
      body: `PRIVACY POLICY — Last Updated: September 2026

1. INFORMATION WE COLLECT
We collect wallet addresses used to connect to our platform, transaction data related to purchases, optional email addresses provided during purchase, and basic analytics data through Google Analytics.

2. HOW WE USE INFORMATION
Wallet addresses are used to process purchases, allocate tokens, and manage referral programs. Email addresses are used to send purchase confirmations and optional updates. Analytics data helps us improve the platform.

3. BLOCKCHAIN DATA
Wallet addresses and transaction data are recorded on public blockchains. This data is inherently public and cannot be deleted.

4. COOKIES
We use essential cookies for site functionality and analytics cookies (Google Analytics) to understand site usage. You can manage cookie preferences through your browser settings.

5. DATA SHARING
We do not sell personal data. We may share data with service providers (Alchemy, Resend) who help operate the platform. We may disclose data if required by law.

6. DATA RETENTION
Transaction records are retained indefinitely as they are part of the blockchain. Email addresses are retained until you unsubscribe. Analytics data is retained per Google Analytics policies.

7. YOUR RIGHTS
You may request access to your data, unsubscribe from emails, or contact us with privacy concerns at support@flowdexprotocol.com.

8. SECURITY
We implement industry-standard security measures including HTTPS encryption, webhook signature verification, and rate limiting.

9. CHANGES
We may update this policy at any time. Changes will be posted on this page.`,
    },
  },
  legal: {
    content: {
      body: `LEGAL NOTICE AND DISCLAIMER — Last Updated: September 2026

IMPORTANT: Please read this notice carefully before using the FlowDex Protocol platform or purchasing $FDP tokens.

NOT FINANCIAL ADVICE
Nothing on this website constitutes financial, investment, legal, or tax advice. $FDP is a utility token designed to provide access to FlowDex Protocol services. You should consult with qualified professionals before making any financial decisions.

NO GUARANTEE OF VALUE
$FDP tokens have no guaranteed value. Market cap scenarios shown on this website are illustrative only and do not constitute promises or predictions. The value of $FDP may decrease, and you may lose your entire purchase amount.

REGULATORY STATUS
$FDP is a utility token and is not intended to be a security in any jurisdiction. FlowDex Protocol does not offer securities. The regulatory status of cryptocurrency tokens varies by jurisdiction and is subject to change.

FORWARD-LOOKING STATEMENTS
This website contains forward-looking statements about FlowDex Protocol development, features, and roadmap. These statements are based on current plans and expectations and may change. There is no guarantee that any planned feature will be developed or launched.

THIRD-PARTY SERVICES
FlowDex Protocol integrates with third-party services including blockchain networks, wallet providers, and payment processors. We are not responsible for the availability or security of third-party services.

JURISDICTION
Access to FlowDex Protocol may be restricted in certain jurisdictions. You are responsible for ensuring compliance with your local laws and regulations.

CONTACT
For legal inquiries, contact support@flowdexprotocol.com`,
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

async function seedBlogPosts() {
  let inserted = 0;
  for (const p of blogPosts) {
    const result = await pool.query(
      `INSERT INTO cms_blog_posts (title, slug, excerpt, content, category, author, is_published, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,true,NOW())
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [p.title, p.slug, p.excerpt, p.content, p.category, p.author]
    );
    if (result.rows.length > 0) inserted++;
  }
  console.log(`Seeded ${inserted} blog post(s) (${blogPosts.length - inserted} already existed and were left untouched)`);
}

// Maps a page/section/field to the input the admin dashboard should render
// for it. Checked in order — the first match wins — so put the specific
// exceptions (image_url, description) ahead of the generic _url/_link
// suffix rule.
function inferFieldType(page, section, field) {
  if (field === 'image_url') return 'media'; // ecosystem_N.image_url + logo.image_url
  if (field === 'description') return 'textarea';
  if (page === 'global' && section === 'logo' && field === 'type') return 'text';
  if (page === 'global' && section === 'social') return 'url'; // twitter/telegram/discord
  if (page === 'global' && section === 'support' && field === 'telegram') return 'url';
  if (field.endsWith('_url') || field.endsWith('_link')) return 'url'; // cta_*_link, link_N_url, buy_button_url
  if (page === 'tokenomics' && section === 'distribution') return 'number';
  if ((page === 'terms' || page === 'privacy' || page === 'legal') && field === 'body') return 'textarea';
  return 'text';
}

async function seedPageContent() {
  // DO NOTHING (not DO UPDATE) — this script is re-run on every deploy, and
  // an admin may have already edited a field via the CMS dashboard by then.
  // Re-seeding must never clobber a live edit; it only fills in fields that
  // don't exist yet (this deliberately means field_type/order on a field
  // that already exists from before this migration is NOT backfilled here
  // — a one-off migration query handles pre-existing rows instead).
  let inserted = 0;
  let skipped = 0;
  for (const [page, sections] of Object.entries(pageContent)) {
    let sectionOrder = 0;
    for (const [section, fields] of Object.entries(sections)) {
      let fieldOrder = 0;
      for (const [field, value] of Object.entries(fields)) {
        const fieldType = inferFieldType(page, section, field);
        const result = await pool.query(
          `INSERT INTO cms_pages (page, section, field, value, field_type, section_order, field_order, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
           ON CONFLICT (page, section, field) DO NOTHING
           RETURNING id`,
          [page, section, field, value, fieldType, sectionOrder, fieldOrder]
        );
        if (result.rows.length > 0) inserted++;
        else skipped++;
        fieldOrder++;
      }
      sectionOrder++;
    }
  }
  console.log(`Page content: ${inserted} fields inserted, ${skipped} already existed and were left untouched`);
}

// One-off backfill: rows inserted before this migration (field_type/order
// columns didn't exist yet) all default to field_type='text',
// section_order=0, field_order=0 from the ALTER TABLE. Re-derive the
// correct field_type for any field seed-cms.js knows about, and reassign
// orders to match pageContent's declaration order, WITHOUT touching value
// (an admin may have already edited it).
async function backfillFieldMeta() {
  let updated = 0;
  for (const [page, sections] of Object.entries(pageContent)) {
    let sectionOrder = 0;
    for (const [section, fields] of Object.entries(sections)) {
      let fieldOrder = 0;
      for (const field of Object.keys(fields)) {
        const fieldType = inferFieldType(page, section, field);
        const result = await pool.query(
          `UPDATE cms_pages SET field_type = $4, section_order = $5, field_order = $6
           WHERE page = $1 AND section = $2 AND field = $3
             AND field_type = 'text' AND section_order = 0 AND field_order = 0`,
          [page, section, field, fieldType, sectionOrder, fieldOrder]
        );
        updated += result.rowCount;
        fieldOrder++;
      }
      sectionOrder++;
    }
  }
  console.log(`Backfilled field_type/order for ${updated} pre-existing row(s)`);
}

async function seed() {
  try {
    await seedBanners();
    await seedFaqs();
    await seedBlogPosts();
    await seedPageContent();
    await backfillFieldMeta();
    console.log('CMS seed complete');
  } catch (err) {
    console.error('CMS seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seed();
