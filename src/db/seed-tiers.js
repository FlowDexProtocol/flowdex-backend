require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const tiers = [
  { id:1, name:'Genesis',     price:0.001, cap:5000000,  tge:5,   cliff:12, vest:24, active:true  },
  { id:2, name:'Pioneer',     price:0.005, cap:8000000,  tge:8,   cliff:9,  vest:18, active:false },
  { id:3, name:'Seed',        price:0.01,  cap:10000000, tge:10,  cliff:6,  vest:15, active:false },
  { id:4, name:'Early Bird',  price:0.015, cap:12000000, tge:15,  cliff:4,  vest:12, active:false },
  { id:5, name:'Builder',     price:0.02,  cap:15000000, tge:20,  cliff:3,  vest:9,  active:false },
  { id:6, name:'Accelerator', price:0.03,  cap:15000000, tge:30,  cliff:2,  vest:6,  active:false },
  { id:7, name:'Growth',      price:0.04,  cap:10000000, tge:50,  cliff:1,  vest:3,  active:false },
  { id:8, name:'Launch',      price:0.05,  cap:5000000,  tge:100, cliff:0,  vest:0,  active:false },
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
  console.log('All 8 tiers seeded');
  await pool.end();
}
seed();
