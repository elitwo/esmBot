// code provided by tzlil

require("dotenv").config();
const os = require("os");
const { Worker, isMainThread, parentPort } = require("worker_threads");
const magick = require("../utils/image.js");
const execPromise = require("util").promisify(require("child_process").exec);
const net = require("net");
const dgram = require("dgram"); // for UDP servers
const socket = dgram.createSocket("udp4"); // Our universal UDP socket, this might cause issues and we may have to use a seperate socket for each connection

var start = process.hrtime();
const log = (msg, thread) => {
  console.log(`[${process.hrtime(start)[1] / 1000000}${(thread)?`:${thread}`:""}]\t ${msg}`);
};

const jobs = {};
// Should look like UUID : { addr : "someaddr", port: someport msg: "request" }
const queue = [];
// Array of UUIDs

if (isMainThread) {
  const { v4: uuidv4 } = require("uuid");

  const MAX_WORKERS = process.env.WORKERS === "" ? parseInt(process.env.WORKERS) : os.cpus().length * 4; // Completely arbitrary, should usually be some multiple of your amount of cores
  let workingWorkers = 0;

  const acceptJob = (uuid) => {
    workingWorkers++;
    const worker = new Worker(__filename);
    queue.shift();
    worker.once("message", (uuid) => {
      // This means the worker is finished
      workingWorkers--;
      if (queue.length > 0) {
        acceptJob(queue[0]); // Get the next job UUID in queue and remove it from the original queue
        delete jobs[uuid];
      }
    });
    worker.on("error", err => {
      console.error("worker error:", err);
      socket.send(Buffer.concat([Buffer.from([0x2]), Buffer.from(uuid), Buffer.from(err.toString())]), jobs[uuid].port, jobs[uuid].addr);

      workingWorkers--;
      if (queue.length > 0) {
        acceptJob(queue[0]);
        delete jobs[uuid];
      }
    });
    worker.on("exit", (code) => {
      workingWorkers--;
      if (queue.length > 0) {
        acceptJob(queue[0]);
        delete jobs[uuid];
      }

      if (code !== 0) console.error(`Worker stopped with exit code ${code}`);
    });


    worker.postMessage({
      uuid: uuid,
      msg: jobs[uuid].msg,
      addr: jobs[uuid].addr,
      port: jobs[uuid].port,
      threadNum: workingWorkers
    });
  };

  const server = dgram.createSocket("udp4"); //Create a UDP server for listening to requests, we dont need tcp
  server.on("message", (msg, rinfo) => {
    const opcode = msg.readUint8(0);
    const req = msg.toString().slice(1,msg.length);
    // 0x0 == Cancel job
    // 0x1 == Queue job
    if (opcode == 0x0) {
      queue.shift();
      delete jobs[req];
    } else if (opcode == 0x1) {
      const job = { addr: rinfo.address, port: rinfo.port, msg: req };
      const uuid = uuidv4();
      jobs[uuid] = job;
      queue.push(uuid);

      if (workingWorkers < MAX_WORKERS) {
        acceptJob(uuid);
      }

      const newBuffer = Buffer.concat([Buffer.from([0x0]), Buffer.from(uuid)]);
      socket.send(newBuffer, rinfo.port, rinfo.address);
    } else {
      log("Could not parse message");
    }
  });

  server.on("listening", () => {
    const address = server.address();
    log(`server listening ${address.address}:${address.port}`);
  });

  server.bind(8080); // ATTENTION: Always going to be bound to 0.0.0.0 !!!
} else {
  parentPort.once("message", async (job) => {
    log(`${job.uuid} worker got: ${job.msg}`, job.threadNum);

    try {
      const object = JSON.parse(job.msg);
      let type;
      if (object.path) {
        type = object.type;
        if (!object.type) {
          type = await magick.getType(object.path);
        }
        if (!type) {
          throw new TypeError("Unknown image type");
        }
        object.type = type.split("/")[1];
        if (object.type !== "gif" && object.onlyGIF) throw new TypeError(`Expected a GIF, got ${object.type}`);
        object.delay = object.delay ? object.delay : 0;
      }
      
      if (object.type === "gif" && !object.delay) {
        const delay = (await execPromise(`ffprobe -v 0 -of csv=p=0 -select_streams v:0 -show_entries stream=r_frame_rate ${object.path}`)).stdout.replace("\n", "");
        object.delay = (100 / delay.split("/")[0]) * delay.split("/")[1];
      }

      const data = await magick.run(object, true);

      log(`${job.uuid} is done`, job.threadNum);
      const server = net.createServer(function(socket) {
        socket.write(Buffer.concat([Buffer.from(type ? type : "image/png"), Buffer.from("\n"), data]));
        socket.end();
        process.exit();
      });
      server.listen(job.port, job.addr);
      // handle address in use errors
      server.on("error", (e) => {
        if (e.code === "EADDRINUSE") {
          console.log("Address in use, retrying...");
          setTimeout(() => {
            server.close();
            server.listen(job.port, job.addr);
          }, 500);
        }
      });
      socket.send(Buffer.concat([Buffer.from([0x1]), Buffer.from(job.uuid), Buffer.from(job.port.toString())]), job.port, job.addr);
      parentPort.postMessage(job.uuid); //Inform main thread about this worker freeing up
    } catch (e) {
      socket.send(Buffer.concat([Buffer.from([0x2]), Buffer.from(job.uuid), Buffer.from(e.toString())]), job.port, job.address);
      parentPort.postMessage(job.uuid);
    }
  });
}