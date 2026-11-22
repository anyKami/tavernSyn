import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsbController, usbMode } from '../helper/usb-controller.mjs';

const wait = async (predicate, message = 'condition not met') => {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail(message);
};
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }
const device={deviceId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',deviceName:'local'};
const peer={deviceId:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',deviceName:'other'};
function fakeLifecycle() {
    return {
        child: {}, stopped: false, closing: false, onRequest() {}, stops: 0, starts: 0, verified: 0,
        async receipt(nonce) { return {nonce,created:Date.now(),files:[]}; },
        async verifyReceipt(r) { assert.ok(r); this.verified++; },
        async stop(options) { assert.equal(options.fast,true); assert.equal(this.stopped,false); this.stopped = true; this.stops++; },
        async start() { assert.equal(this.stopped,true); this.stopped = false; this.starts++; },
    };
}
class FakeSession {
    constructor(device,{lifecycle}) { this.device=device;this.lifecycle=lifecycle;this.opened=false;this.stage='idle';this.locks=[];this.manager={job:null}; }
    async open(options) { assert.deepEqual(options,{managedLauncher:true}); assert.equal(this.lifecycle.stopped,true); this.opened=true;this.openCount=(this.openCount||0)+1; }
    async close() { this.opened=false; }
    async fail(error) { this.stage='failed';this.manager.job={error:{message:error.message}}; }
}
function controller(mode, adapter={}) {
    const lifecycle=fakeLifecycle(),manager={busy:false,async status(){return{phase:'IDLE'};}};
    const c=new UsbController(device,lifecycle,manager,{mode,adapter:{UsbSession:FakeSession,...adapter},log:()=>{}});
    const receipt='cccccccc-cccc-cccc-cccc-cccccccccccc',tab='dddddddd-dddd-dddd-dddd-dddddddddddd';
    return {c,lifecycle,manager,receipt,tab,connect:()=>c.connect({receipt,tab})};
}
test('platform detection uses local Node runtime, never a browser user-agent',()=>{
    assert.equal(usbMode('win32',{}),'client');
    assert.equal(usbMode('android',{}),'serve');
    assert.equal(usbMode('linux',{PREFIX:'/data/data/com.termux/files/usr'}),'serve');
    assert.equal(usbMode('linux',{TERMUX_VERSION:'0.121'}),'serve');
    assert.equal(usbMode('linux',{}),null);
    assert.equal(usbMode('darwin',{}),null);
});
test('unsupported platform cannot initiate any synchronization',async()=>{
    const {c,connect,manager}=controller(null);
    assert.equal(c.status().supported,false);
    await assert.rejects(connect(),{code:'UNMANAGED'});
    assert.equal(manager.busy,false);
});
test('phone starts server while ST remains alive; phone UI chooses once; ST stops then restarts',async()=>{
    const connected=deferred(),selected=deferred(),closed=deferred();
    let server;
    const {c,connect,lifecycle,manager}=controller('serve',{
        async startUsbServer(session, options) {
            server={connected:connected.promise,selection:selected.promise,closed:closed.promise,
                chooseDirection(direction){const choice={direction,id:'12345678-1234-1234-1234-123456789abc',selectedBy:'phone'};selected.resolve(choice);return choice;},
                async close(){connected.resolve(null);selected.resolve(null);closed.resolve();},
            };
            return server;
        },
    });
    assert.equal((await connect()).stage,'connecting');
    await wait(()=>c.status().stage==='waiting');
    assert.equal(lifecycle.stops,0,'connected-mode must never stop ST before a direction is chosen');
    connected.resolve(peer);
    await wait(()=>c.status().stage==='connected');
    assert.equal(manager.busy,true);
    assert.equal((await c.select('push')).selection.direction,'push');
    await wait(()=>c.status().stage==='transferring');
    assert.equal(lifecycle.stops,1);
    assert.equal(c.session.openCount,1);
    c.session.stage='completed';closed.resolve();
    await wait(()=>c.status().stage==='completed'&&!manager.busy);
    assert.equal(lifecycle.starts,1);
    assert.equal(lifecycle.stopped,false);
    assert.equal(lifecycle.verified,0,'a late automatic save must not require another confirmation');
});
test('computer can choose direction in frontend; USB client mirrors and normal ST restarts',async()=>{
    const selection=deferred();
    let tunnelClosed=false,peerClosed=false, directionUsed;
    const {c,connect,lifecycle,manager}=controller('client',{
        async connectUsb(){return{origin:'http://127.0.0.1:45678/',async close(){tunnelClosed=true;}};},
        async waitForUsbPeer(){return{peer,token:'e'.repeat(32),waitForSelection:()=>selection.promise,
            async chooseDirection(direction){const choice={id:'12345678-1234-1234-1234-123456789abc',direction,selectedBy:'computer'};selection.resolve(choice);return choice;},
            close(){peerClosed=true;}};},
        async syncUsb(session,options){directionUsed=options.direction;assert.equal(session.opened,true);session.stage='completed';return{result:{applied:true}};},
    });
    await connect();await wait(()=>c.status().stage==='connected');
    assert.equal(lifecycle.stops,0);
    await c.select('pull');
    await wait(()=>c.status().stage==='completed'&&!manager.busy);
    assert.equal(directionUsed,'pull');
    assert.equal(lifecycle.stops,1);
    assert.equal(lifecycle.starts,1);
    assert.equal(tunnelClosed,true);
    assert.equal(peerClosed,true);
});
test('phone UI can choose the direction and the waiting computer follows it',async()=>{
    const selected=deferred();
    const {c,connect,lifecycle}=controller('client',{
        async connectUsb(){return{origin:'http://127.0.0.1:45678/',async close(){}};},
        async waitForUsbPeer(){return{peer,token:'e'.repeat(32),waitForSelection:()=>selected.promise,
            chooseDirection(){assert.fail('computer should not choose')},close(){}};},
        async syncUsb(session,options){assert.equal(options.direction,'push');session.stage='completed';return{result:{applied:true}};},
    });
    await connect();await wait(()=>c.status().stage==='connected');
    selected.resolve({id:'12345678-1234-1234-1234-123456789abc',direction:'push',selectedBy:'phone'});
    await wait(()=>c.status().stage==='completed');
    assert.equal(lifecycle.stops,1);
    assert.equal(lifecycle.starts,1);
});
test('cancel before direction never stops the running ST or creates an offline USB session',async()=>{
    const connected=deferred(),selected=deferred(),closed=deferred();
    const {c,connect,lifecycle,manager}=controller('serve',{
        async startUsbServer(){return{connected:connected.promise,selection:selected.promise,closed:closed.promise,
            chooseDirection(){assert.fail('cancelled')},
            async close(){connected.resolve(null);selected.resolve(null);closed.resolve();}};},
    });
    await connect();await wait(()=>c.status().stage==='waiting');
    await c.cancel();
    await wait(()=>c.status().stage==='cancelled'&&!manager.busy);
    assert.equal(lifecycle.stops,0);
    assert.equal(lifecycle.starts,0);
});
test('a failed USB transfer returns to the original ST and releases the manager',async()=>{
    const selected=deferred();
    const {c,connect,lifecycle,manager}=controller('client',{
        async connectUsb(){return{origin:'http://127.0.0.1:45678/',async close(){}};},
        async waitForUsbPeer(){return{peer,token:'e'.repeat(32),waitForSelection:()=>selected.promise,
            async chooseDirection(direction){const choice={id:'12345678-1234-1234-1234-123456789abc',direction,selectedBy:'computer'};selected.resolve(choice);return choice;},close(){}};},
        async syncUsb(){throw Object.assign(new Error('USB cable disconnected'),{code:'USB_NETWORK'});},
    });
    await connect();await wait(()=>c.status().stage==='connected');
    await c.select('push');
    await wait(()=>c.status().stage==='failed'&&!manager.busy);
    assert.equal(lifecycle.stops,1);
    assert.equal(lifecycle.starts,1);
    assert.equal(c.session.opened,false);
    assert.equal(c.status().error.code,'USB_FAILED');
});
test('busy or unfinished jobs and invalid receipts refuse connection before touching ST',async()=>{
    const v=controller('serve');v.manager.busy=true;
    await assert.rejects(v.connect(),{code:'BUSY'});
    v.manager.busy=false;v.manager.status=async()=>({phase:'RECOVERY_REQUIRED'});
    await assert.rejects(v.connect(),{code:'RECOVERY_REQUIRED'});
    assert.equal(v.lifecycle.stops,0);
});
