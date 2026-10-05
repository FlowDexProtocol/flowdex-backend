require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 20 tiers, ~17.08% geometric price progression (whitepaper v8.0). `id` is
// the sort key everywhere tiers are queried (always `ORDER BY id` — there's
// no separate sort_order column on the table), so it must match tier number.
const tiers = [
  { id:1,  name:'Genesis',     price:0.0005,  cap:5000000, tge:5,   cliff:12, vest:24, active:true  },
  { id:2,  name:'Pioneer',     price:0.00059, cap:5500000, tge:6,   cliff:11, vest:22, active:false },
  { id:3,  name:'Seed',        price:0.00069, cap:6000000, tge:7,   cliff:10, vest:20, active:false },
  { id:4,  name:'Early Bird',  price:0.00080, cap:6500000, tge:8,   cliff:9,  vest:18, active:false },
  { id:5,  name:'Builder',     price:0.00094, cap:7000000, tge:10,  cliff:8,  vest:16, active:false },
  { id:6,  name:'Accelerator', price:0.00110, cap:7500000, tge:12,  cliff:7,  vest:15, active:false },
  { id:7,  name:'Growth',      price:0.00129, cap:8000000, tge:15,  cliff:6,  vest:14, active:false },
  { id:8,  name:'Momentum',    price:0.00151, cap:8000000, tge:18,  cliff:6,  vest:12, active:false },
  { id:9,  name:'Velocity',    price:0.00177, cap:7500000, tge:20,  cliff:5,  vest:11, active:false },
  { id:10, name:'Horizon',     price:0.00207, cap:7500000, tge:22,  cliff:5,  vest:10, active:false },
  { id:11, name:'Frontier',    price:0.00242, cap:7000000, tge:25,  cliff:4,  vest:9,  active:false },
  { id:12, name:'Apex',        price:0.00284, cap:7000000, tge:28,  cliff:4,  vest:8,  active:false },
  { id:13, name:'Vanguard',    price:0.00332, cap:6500000, tge:30,  cliff:3,  vest:7,  active:false },
  { id:14, name:'Catalyst',    price:0.00389, cap:6500000, tge:35,  cliff:3,  vest:6,  active:false },
  { id:15, name:'Summit',      price:0.00455, cap:6000000, tge:40,  cliff:2,  vest:5,  active:false },
  { id:16, name:'Titan',       price:0.00533, cap:6000000, tge:45,  cliff:2,  vest:4,  active:false },
  { id:17, name:'Eclipse',     price:0.00624, cap:5500000, tge:50,  cliff:1,  vest:3,  active:false },
  { id:18, name:'Pinnacle',    price:0.00729, cap:5500000, tge:60,  cliff:1,  vest:2,  active:false },
  { id:19, name:'Zenith',      price:0.00854, cap:5000000, tge:80,  cliff:0,  vest:1,  active:false },
  { id:20, name:'Prestige',    price:0.01000, cap:5000000, tge:100, cliff:0,  vest:0,  active:false },
];

async function seed() {
  for (const t of tiers) {
    await pool.query(
      `INSERT INTO tiers (id,name,price,hard_cap_usd,is_active,tge_percentage,cliff_months,vest_months,opened_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET name=$2,price=$3,hard_cap_usd=$4,is_active=$5,tge_percentage=$6,cliff_months=$7,vest_months=$8`,
      [t.id, t.name, t.price, t.cap, t.active, t.tge, t.cliff, t.vest, t.active ? new Date() : null]
    );
  }
  console.log('All 20 tiers seeded');
  await pool.end();
}
seed();
