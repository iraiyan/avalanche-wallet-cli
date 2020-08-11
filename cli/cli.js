#!/usr/bin/env node

// Required by ledgerjs
require("babel-polyfill");

const HDKey = require('hdkey');
const createHash = require('create-hash');
const BN = require("bn.js");
const URI = require("urijs");
const commander = require("commander");
const AvaJS = require("avalanche");
const TransportNodeHid = require("@ledgerhq/hw-transport-node-hid").default;
const Ledger = require("@ledgerhq/hw-app-avalanche").default;

const BinTools = AvaJS.BinTools.getInstance();

const AVAX_ASSET_ID = "AVA"; // TODO changes to AVAX in next release
const AVAX_ASSET_ID_SERIALIZED = BinTools.b58ToBuffer("9xc4gcJYYg1zfLeeEFQDLx4HnCk81yUmV1DAUc6VfJFj"); // TODO is this correct? I got this from my account's UTXOSet. I have no idea how it is created.
const AVA_BIP32_PREFIX = "m/44'/9000'/0'" // Restricted to 0' for now
const INDEX_RANGE = 20; // a gap of at least 20 indexes is needed to claim an index unused
const SCAN_SIZE = 70; // the total number of utxos to look at initially to calculate last index

// TODO replace this with something better
function log_error_and_exit(err) {
  if (err.message === undefined) {
    console.error(err);
  } else {
    console.error(err.message);
  }
  process.exit(1);
}

// Convenience function to add the --device option
commander.Command.prototype.add_device_option = function() {
  return this.option("-d, --device <device>", "device to use");
}

// Convenience function to add the --node option
commander.Command.prototype.add_node_option = function() {
  return this.option("-n, --node <uri>", "node to use", "https://testapi.avax.network");
}

function ava_js_with_node(uri_string) {
  const uri = URI(uri_string);
  return new AvaJS.Avalanche(uri.hostname(), uri.port(), uri.protocol(), 3);
}

const program = new commander.Command();

program.version("0.0.1");

program
  .command("list-devices")
  .description("List all Ledger devices currently available")
  .action(async () => {
  console.log(await TransportNodeHid.list());
});

program
  .command("get-device-model")
  .description("Get the device model of the connected ledger")
  .add_device_option()
  .action(async (options) => {
    const transport = await TransportNodeHid.open(options.device).catch(log_error_and_exit);
    console.log(transport.deviceModel);
});

program
  .command("get-wallet-id")
  .add_device_option()
  .action(async (options) => {
    const transport = await TransportNodeHid.open(options.device).catch(log_error_and_exit);
    const ledger = new Ledger(transport);
    const result = await ledger.getWalletId().catch(log_error_and_exit);
    console.log(result);
});

program
  .command("get-public-key <path>")
  .option("--extended", "Get the extended public key")
  .description("get the public key of a derivation path. <path> should be 'change/address_index'")
  .add_device_option()
  .action(async (path, options) => {
    const transport = await TransportNodeHid.open(options.device).catch(log_error_and_exit);
    const ledger = new Ledger(transport);
    // BIP32: m / purpose' / coin_type' / account' / change / address_index
    path = AVA_BIP32_PREFIX + "/" + path
    if (options.extended) {
      console.error("Getting extended public key for path", path);
      const result = await ledger.getWalletExtendedPublicKey(path).catch(log_error_and_exit);
      console.log(result);
    } else {
      console.error("Getting public key for path ", path);
      const pubk = await ledger.getWalletPublicKey(path).catch(log_error_and_exit);
      KC = new AvaJS.AVMKeyPair();
      pubk_hash = KC.addressFromPublicKey(pubk);
      address = BinTools.avaSerialize(pubk_hash);
      console.log(address);
    }
});

async function get_extended_public_key(ledger, deriv_path) {
  console.error("Please accept on your ledger device");
  extended_public_key = await ledger.getWalletExtendedPublicKey(deriv_path).catch(log_error_and_exit);
  hdw = new HDKey();
  hdw.publicKey = extended_public_key.public_key;
  hdw.chainCode = extended_public_key.chain_code;
  return hdw
}

// Scan addresses and find the first unused address (i.e. the first with no UTXOs)
async function get_first_unused_address(avm, hdkey, log = false) {
  var utxoset = new AvaJS.UTXOSet();
  var addresses = [];
  var pkhs = [];
  var change_addresses = [];
  var change_pkhs = [];

  await traverse_used_keys(avm, hdkey, batch => {
    utxoset = utxoset.union(batch.utxoset);
    addresses = addresses.concat(batch.non_change.addresses);
    pkhs = pkhs.concat(batch.non_change.pkhs);
    change_addresses = change_addresses.concat(batch.change.addresses);
    change_pkhs = change_pkhs.concat(batch.change.pkhs);
  });

  // Go backwards through the generated addresses to find the last unused address
  last_unused = null;
  for (var i = addresses.length - 1; i >= 0; i--) {
    const pkh = pkhs[i].toString('hex');
    const utxoids = utxoset.addressUTXOs[pkh];
    const change_pkh = change_pkhs[i].toString('hex');
    const change_utxoids = utxoset.addressUTXOs[change_pkh];
    if (utxoids === undefined && change_utxoids === undefined) {
      last_unused = {
        non_change: addresses[i],
        change: change_addresses[i],
      };
    } else {
      break;
    }
  };

  return last_unused;
}

function hdkey_to_pkh(hdkey) {
  const KC = new AvaJS.AVMKeyPair();
  return KC.addressFromPublicKey(hdkey.publicKey);
}

function pkh_to_avax_address(pkh) {
  return "X-" + BinTools.avaSerialize(pkh);
}

// Convert a 'hdkey' (from the library of the same name) to an AVAX address.
function hdkey_to_avax_address(hdkey) {
  return pkh_to_avax_address(hdkey_to_pkh(hdkey));
}

// Traverse children of a hdkey with the given function. Stops when at least
// INDEX_RANGE addresses are "unused" (right now, this means they have no UTXOs)
// TODO check TX history too to determine unused status
async function traverse_used_keys(avm, hdkey, batched_function) {
  // getUTXOs is slow, so we generate INDEX_RANGE addresses at a time and batch them
  // Only when INDEX_RANGE addresses have no UTXOs do we assume we are done
  var index = 0;
  var all_unused = false;
  while (!all_unused || index < SCAN_SIZE) {
    const batch = {
      address_to_path: {}, // A dictionary from AVAX address to path (change/address)
      non_change: { addresses: [], pkhs: []},
      change: { addresses: [], pkhs: []},
    };
    for (var i = 0; i < INDEX_RANGE; i++) {
      const child = hdkey.deriveChild(0).deriveChild(index + i);
      const change_child = hdkey.deriveChild(1).deriveChild(index + i);
      const pkh = hdkey_to_pkh(child);
      const change_pkh = hdkey_to_pkh(change_child);
      batch.non_change.pkhs.push(pkh);
      batch.change.pkhs.push(change_pkh);
      const address = pkh_to_avax_address(pkh);
      const change_address = pkh_to_avax_address(change_pkh);
      batch.non_change.addresses.push(address);
      batch.change.addresses.push(change_address);
      batch.address_to_path[address] = "0/" + (index + i);
      batch.address_to_path[change_address] = "1/" + (index + i);
    }
    // Get UTXOs for this batch
    batch.utxoset = await
      avm.getUTXOs(batch.non_change.addresses.concat(batch.change.addresses))
      .catch(log_error_and_exit);

    // Run the batch function
    batched_function(batch);

    index = index + INDEX_RANGE;
    all_unused = batch.utxoset.getAllUTXOs().length === 0;
  }
}

// Given a hdkey (at the account level), sum the UTXO balances
// under that key.
async function sum_child_balances(avm, hdkey, log = false) {
  var balance = new BN(0);

  await traverse_used_keys(avm, hdkey, async (batch) => {
    // Total the balance for all PKHs
    for (const [pkh, utxoids] of Object.entries(batch.utxoset.addressUTXOs)) {
      var bal = new BN(0);
      for (const utxoid of Object.keys(utxoids)) {
        bal = bal.add(batch.utxoset.utxos[utxoid].getOutput().getAmount());
      }
      if (log) {
        const addr = pkh_to_avax_address(Buffer.from(pkh, 'hex'));
        console.error(batch.address_to_path[addr], addr, bal.toString());
      }
      balance = balance.add(bal);
    };
  });

  return balance;
}

// Given a hdkey (at the change or non-change level), get the full UTXO set for
// all addresses under that key. This also returns the addresses in path index
// order, and a dictionary for getting path index from UTXOID. This dictionary
// is used for determining which paths to sign via the ledger.
async function prepare_for_transfer(avm, hdkey) {
  // Return values
  var utxoset = new AvaJS.UTXOSet();
  var addresses = [];
  var change_addresses = [];
  var utxoid_to_path = {}; // A dictionary from UTXOID to path (change/address)

  await traverse_used_keys(avm, hdkey, batch => {
    // Update the UTXOID -> index dictionary
    // TODO does this need to be UTXOID -> [index], or does UTXOID -> index suffice?
    // i.e. are we clobbering existing indices?
    for (const [pkh, utxos] of Object.entries(batch.utxoset.addressUTXOs)) {
      const addr = pkh_to_avax_address(Buffer.from(pkh, 'hex'));
      for (const utxoid of Object.keys(utxos)) {
        utxoid_to_path[utxoid] = batch.address_to_path[addr];
      }
    };

    utxoset = utxoset.union(batch.utxoset);
    addresses = addresses.concat(batch.non_change.addresses);
    change_addresses = change_addresses.concat(batch.change.addresses);
  });

  return {
    utxoset: utxoset,
    // We build the from addresses from all discovered change addresses,
    // followed by all discovered non-change addresses. This matches the web
    // wallet.
    // buildBaseTx will filter down to the minimum requirement in the order of
    // this array (and it is ordered by increasing path index).
    addresses: change_addresses.concat(addresses),
    utxoid_to_path: utxoid_to_path,
  }
}

program
  .command("get-balance [address]")
  .option("--list-addresses", "Display a breakdown for individual addresses")
  .description("Get the AVAX balance of this wallet or a particular address")
  .add_node_option()
  .add_device_option()
  .action(async (address, options) => {
    const ava = ava_js_with_node(options.node);
    const avm = ava.AVM();

    if (address === undefined) {
      const transport = await TransportNodeHid.open(options.device).catch(log_error_and_exit);
      const ledger = new Ledger(transport);

      const root_key = await get_extended_public_key(ledger, AVA_BIP32_PREFIX);
      const balance = await sum_child_balances(avm, root_key, options.listAddresses);
      console.log(balance.toString());
    } else {
      let result = await avm.getBalance(address, AVAX_ASSET_ID).catch(log_error_and_exit);
      console.log(result.toString(10, 0));
    }
});

program
  .command("get-new-receive-address")
  .description("Get a fresh address for receiving funds")
  .add_node_option()
  .add_device_option()
  .action(async options => {
    const avm = ava_js_with_node(options.node).AVM();
    const transport = await TransportNodeHid.open(options.device).catch(log_error_and_exit);
    const ledger = new Ledger(transport);
    const root_key = await get_extended_public_key(ledger, AVA_BIP32_PREFIX);
    let result = await get_first_unused_address(avm, root_key, true);
    console.log(result.non_change);
});

/* Adapted from avm/tx.ts for class UnsignedTx */
async function sign_UnsignedTx(unsignedTx, utxo_id_to_path) {
  const txbuff = unsignedTx.toBuffer();
  const hash = Buffer.from(createHash('sha256').update(txbuff).digest());
  const baseTx = unsignedTx.transaction;
  const sigs = await sign_BaseTx(baseTx, hash, utxo_id_to_path);
  return new AvaJS.Tx(unsignedTx, sigs);
}

/* Adapted from avm/tx.ts for class BaseTx */
async function sign_BaseTx(baseTx, hash, utxo_id_to_path) {
  // TODO maybe these should be moved out and passed in
  const transport = await TransportNodeHid.open().catch(log_error_and_exit);
  const ledger = new Ledger(transport);

  const sigs = [];
  // For each tx input (sources of funds)
  for (let i = 0; i < baseTx.ins.length; i++) {
    const input = baseTx.ins[i];
    const cred = AvaJS.SelectCredentialClass(input.getInput().getCredentialID());
    const sigidxs = input.getInput().getSigIdxs();
    for (let j = 0; j < sigidxs.length; j++) {
      const path = utxo_id_to_path[input.getUTXOID()];
      const result = await sign_with_ledger(ledger, hash, path);
      const sig = new AvaJS.Signature();
      sig.fromBuffer(result.signature);
      cred.addSignature(sig);
    }
    sigs.push(cred);
  }
  return sigs;
}

async function sign_with_ledger(ledger, hash, path) {
  // BIP44: m / purpose' / coin_type' / account' / change / address_index
  const full_path = AVA_BIP32_PREFIX + "/" + path;
  console.error("Signing hash", hash.toString('hex').toUpperCase(), "with path", full_path);
  console.error("Please verify on your ledger device");
  return await ledger.signHash(full_path, hash).catch(log_error_and_exit);
}

function parse_amount(str) {
  try {
    return new BN(str);
  } catch (e) {
    console.error("Couldn't parse amount: ", e.message);
    console.error("Hint: Amount should be an integer, specified in nanoAVAX.");
    process.exit(1);
  }
}

program
  .command("transfer")
  .description("Transfer AVAX between addresses")
  .requiredOption("--amount <amount>", "Amount to transfer, specified in nanoAVAX")
  .requiredOption("--to <account>", "Recipient account")
  .add_node_option()
  .add_device_option()
  .action(async options => {
    const avm = ava_js_with_node(options.node).AVM();
    const transport = await TransportNodeHid.open(options.device).catch(log_error_and_exit);
    const ledger = new Ledger(transport);

    const root_key = await get_extended_public_key(ledger, AVA_BIP32_PREFIX);

    console.error("Discovering addresses...");
    const non_change_key = root_key.deriveChild(0);
    const change_key = root_key.deriveChild(1);
    const prepared = await prepare_for_transfer(avm, root_key);

    const amount = parse_amount(options.amount);
    const toAddress = options.to;
    const fromAddresses = prepared.addresses;

    console.error("Getting new change address...");
    // TODO don't loop again. get this from prepare_for_transfer for the change addresses
    const changeAddress = (await get_first_unused_address(avm, root_key)).change;

    console.error("Building TX...");
    const unsignedTx = await
      avm.buildBaseTx(prepared.utxoset, amount, [toAddress], fromAddresses, [changeAddress], AVAX_ASSET_ID_SERIALIZED)
      .catch(log_error_and_exit);
    const signed = await sign_UnsignedTx(unsignedTx, prepared.utxoid_to_path);
    console.error("Issuing TX...");
    const txid = await avm.issueTx(signed);
    console.log(txid);
});

async function main() {
  await program.parseAsync(process.argv);
}

main();
