// if (process.env.NODE_ENV === 'production') require('newrelic');
require("dotenv").config();
var compression = require("compression");
var express = require("express");
var logger = require("morgan");
var bodyParser = require("body-parser");
var cookieParser = require("cookie-parser");
var expressSanitized = require("express-sanitize-escape");
var helmet = require("helmet");
var admin = require("firebase-admin");
const AWS = require("aws-sdk");
var inspect = require("util").inspect;
const simpleParser = require("mailparser").simpleParser;
const _ = require("lodash");
const fs = require("fs");
const uuidV4 = require("uuid/v4");
const stream = require("stream");
var errorhandler = require("errorhandler");
var path = require("path");
var timeout = require("express-timeout-handler");
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;
var imaps = require("imap");
var JPEGDecoder = require("jpg-stream/decoder");
var { Base64Decode } = require("base64-stream");
var imap;

startImap();

function toUpper(thing) {
  return thing && thing.toUpperCase ? thing.toUpperCase() : thing;
}

function findAttachmentParts(struct, attachments) {
  attachments = attachments || [];
  for (var i = 0, len = struct.length, r; i < len; ++i) {
    if (Array.isArray(struct[i])) {
      findAttachmentParts(struct[i], attachments);
    } else {
      if (
        struct[i].disposition &&
        ["INLINE", "ATTACHMENT"].indexOf(toUpper(struct[i].disposition.type)) >
          -1
      ) {
        attachments.push(struct[i]);
      }
    }
  }
  return attachments;
}

function buildAttMessageFunction(attachment) {
  var filename = attachment.params.name;
  var encoding = attachment.encoding;

  return function(msg, seqno) {
    msg.on("body", function(stream, info) {
      //Create a write stream so that we can stream the attachment to file;
      try {
        var s3 = new AWS.S3({ apiVersion: "2006-03-01" });
        stream.pipe(new Base64Decode()).pipe(uploadFromStream(s3));
      } catch (e) {
        console.log("huge err....", e);
      }
    });
    msg.once("end", function() {
      console.log("Finished attachment");
    });
  };
}

function uploadFromStream(s3) {
  var pass = new stream.PassThrough(s3);
  let key = uuidV4();
  var params = {
    Bucket: "goose-hollow-road",
    Key: `${key}.jpeg`,
    ContentType: "image/jpeg",
    ContentEncoding: "base64",
    ACL: "public-read",
    Body: pass,
  };
  s3.upload(params, async function(err, data) {
    if (err) {
      console.log("ERROR....", err);
    } else {
      console.log("data...", data);
    }
  });

  return pass;
}

function getCodeFromMail() {
  return new Promise(function(resolve, reject) {
    var fetch = imap.search(["UNSEEN", ["SINCE", "May 20, 2010"]], function(
      err,
      results
    ) {
      console.log("results...", results);
      if (err || !results || !results.length) {
        console.log("err here..", err);
        console.log("none");
        resolve();
      } else {
        var f = imap.fetch(results, {
          markSeen: false,
          bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)", "1.1"],
          struct: true,
        }); //ugh
        f.on("message", function(msg, seqno) {
          console.log("Message #%d", seqno);
          var prefix = "(#" + seqno + ") ";
          msg.on("body", function(stream, info) {
            var buffer = "";
            stream.on("data", function(chunk) {
              buffer += chunk.toString("utf8");
            });
            stream.once("end", function() {
              console.log("stream ended");
            });
          });
          msg.once("attributes", function(attrs) {
            console.log("ATTRS....", attrs);
            var attachments = findAttachmentParts(attrs.struct);
            console.log(prefix + "Has attachments: %d", attachments.length);
            for (var i = 0, len = attachments.length; i < len; ++i) {
              var attachment = attachments[i];
              /*This is how each attachment looks like {
              partID: '2',
              type: 'application',
              subtype: 'octet-stream',
              params: { name: 'file-name.ext' },
              id: null,
              description: null,
              encoding: 'BASE64',
              size: 44952,
              md5: null,
              disposition: { type: 'ATTACHMENT', params: { filename: 'file-name.ext' } },
              language: null
            }
          */
              console.log(
                prefix + "Fetching attachment %s",
                attachment.params.name
              );
              var f = imap.fetch(attrs.uid, {
                //do not use imap.seq.fetch here
                bodies: [attachment.partID],
                struct: true,
              });
              //build function to process attachment message
              f.on("message", buildAttMessageFunction(attachment));
            }
          });
          msg.once("end", function() {
            console.log(prefix + "Finished");
          });
        });
        f.once("error", function(err) {
          console.log("Fetch error: " + err);
        });
        f.once("end", function() {
          console.log("Done fetching all messages!");
          // imap.end();
        });
      }
    });
  });
}

function connect() {
  return new Promise(function(resolve, reject) {
    imap.connect();
  });
}

var app = express();

app.use(helmet());
app.use(compression());
app.use(logger("combined"));
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: false, limit: "10mb" }));

var http = require("http");

var server = http.createServer(app);

server.listen(process.env.PORT || 3000, function() {
  console.log(
    "Express server listening on port %d in %s mode",
    this.address().port,
    app.settings.env
  );
});

server.on("error", onError);
server.on("listening", onListening);

/**
 * Event listener for HTTP server "error" event.
 */

function onError(error) {
  console.log(error);
  console.log(error.message);
  if (error.syscall !== "listen") {
    throw error;
  }

  var bind = typeof port === "string" ? "Pipe " + port : "Port " + port;

  // handle specific listen errors with friendly messages
  switch (error.code) {
    case "EACCES":
      console.error(bind + " requires elevated privileges");
      process.exit(1);
      break;
    case "EADDRINUSE":
      console.error(bind + " is already in use");
      process.exit(1);
      break;
    default:
      throw error;
  }
}

/**
 * Event listener for HTTP server "listening" event.
 */

function onListening() {
  var addr = server.address();
  var bind = typeof addr === "string" ? "pipe " + addr : "port " + addr.port;
  console.log("listening...");
}

process.on("uncaughtException", function(err) {
  // handle the error safely
  console.log("bigerrrrrrrrr::::::: \n", err);
});

function startImap() {
  var config = {
    user: process.env.GMAIL_USER,
    password: process.env.GMAIL_PASSWORD,
    host: "imap.gmail.com",
    port: 993,
    tls: true,
    keepalive: { forceNoop: true },
    authTimeout: 3000,
  };

  imap = new imaps(config);

  connect();

  imap.on("ready", function() {
    imap.openBox("INBOX", false, function(err, box) {
      console.log("Success to inbox", box.messages.total);
    });
    imap.on("mail", function(newMail) {
      console.log("New mail", newMail);
      getCodeFromMail();
    });
  });

  imap.once("end", function() {
    console.log("CONNECTION CLOSED....");
    startImap();
  });

  imap.once("error", function(err) {
    console.log("IMAP ERROR.....");
    console.log(err);
    startImap();
  });
}

module.exports = { app };
