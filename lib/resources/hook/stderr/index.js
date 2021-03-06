var responseMethods = require('./responseMethods');
var config = require("../../../../config");

var stderr = {};
module['exports'] = stderr;

// processes incoming stderr buffer
stderr.onData = function onStderrData (data, status, debug, output) {
  var messages = data.toString();


  // Remark: Ignore special case"\nmodule.js:333", which is module require error
  //         This is a bit brittle, but is okay for now
  if (messages.substr(0, 1) !== "{" && messages.substr(0, 14) !== "\nmodule.js:333") {
    // Remark: Encode any non JSON messages as a JSON error message
    var message = { "type": "error", "payload": { "error": messages }};
    return handleMessage(message, status, debug, output);
  } 
  messages = messages.split('\n');
  messages.forEach(function(message){
    if (message.length === 0) {
      return;
    }
    // attempt to parse incoming stderr as JSON message
    try {
      message = JSON.parse(message.toString());
    } catch (err) {
      // don't do anything, ignore
      // message = { "type": "error", "payload": { "error": message.toString() }};
    }
    handleMessage(message, status, debug, output);
  });
};

var handleMessage = stderr.handleMessage = function (message, status, debug, output) {

  var request = require('request');

  /*
    stderr message types:

    error: error event from vm, send error stack as plaintext to client.
    log: console.log logging event, send log entry to logging system
    end: hook.res.end was called inside the vm, call output.end()
    untyped: any untyped messages are considered type `error` and will be wrapped as error types

  */
  // check to see if incoming message is a response method ( like res.writeHead )
  if(typeof responseMethods[message.type] === "function") {
    responseMethods[message.type](message, output);
    return;
  }

  // if the incoming message is end event, signal that is time to end the response
  if (message.type === "end") {
    status.serviceEnded = true;
  }

  // send logging messages to the debug function ( redis logs at this point )
  if (message.type === "log") {
    debug(message.payload.entry);
    return;
  }
  // if the incoming message is an error
  if (message.type === "error") {
    // let's do some custom behavior for MODULE_NOT_FOUND errors,
    // i.e. require('colors') when colors is not installed
    status.erroring = true;
    if (message.payload.code === "MODULE_NOT_FOUND") {
      var missingModule = message.payload.error.replace("Cannot find module '", '');
      missingModule = missingModule.substr(0, missingModule.length - 1);
      // if a module is missing, check to see if it is a valid module,
      // ( exists on npm / doesn't attempt to require other files outside root )

      status.checkingRegistry = true;
      // call out to the hpm server to install the module
      // TODO: make a proper hpm node.js API client
      request({
         uri: "http://localhost:8888/npm/exists",
         method: "POST",
         form: {
           packages: missingModule
         }
       }, function (err, result){
         if (err) {
           if(err.code === "ECONNREFUSED") {
             output.write('Unable to communicate with hpm server \n\n');
             output.write(err.message);
           }
           status.ended = true;
           status.checkingRegistry = false;
           // console.log('npm error called output.end()');
           output.end();
           return;
         }
         if (result.body === "true") {
           // the missing module exists on the public npm registry,
           // let's install it and tell the user it's pending installation

          //  message.payload.error = message.payload.error + "\n\n" + "npm installations are currently disabled. They will be back online soon."
           message.payload.error = message.payload.error + "\n\n" + "It looks like `" + missingModule + "` is a npm dependency. We are going to try to install it!";
           message.payload.error += '\n' + 'It should be ready in a few moments... \n\n';
           message.payload.error += 'Check https://hook.io/packages/npm/installed for updates.\n';
           message.payload.error += 'Pending installations https://hook.io/packages/npm/pending.\n\n';
           output.write(message.payload.error);

           // call out to the hpm server to install the module
           // TODO: make a proper hpm node.js API client
           request({
             uri: "http://localhost:8888/npm/install",
             method: "POST",
             form: {
               packages: missingModule,
               where: config.worker.npmPath
             }
           }, function (err, result) {
             // console.log(err, result.body);
           });

           status.erroring = false;
           status.checkingRegistry = false;
           if(!status.ended) {
             //console.log('npm found module called output.end()');
             status.ended = true;
             output.end();
           }

         } else if (result.body === "false"){
           // we couldn't find the missing module ( for some reason ),
           // show the user
           var str = 'We were unable to find "' + missingModule + '" in the public npm registry! \n\n';
           str +=    "Unable to require module. Sorry.";
           str +=    "If you feel this message is an error, please contact support.";
           output.write(str);
           status.ended = true;
           return output.end();
         } else {
           output.write(result.body);
           status.ended = true;
           return output.end();
         }

       });

    } else {
      status.erroring = true;
      // the process is erroring and its not MODULE_NOT_FOUND.
      // we don't know what happened at this point, or how much more error information is coming
      // let's just set a timer to end the request after a few moments
      // this ensures that most ( if not the entire ) error stack gets sent to the client
      if(!status.ended && output) {
        output.write(message.payload.error);
        setTimeout(function(){
          if (!status.checkingRegistry) {
            status.ended = true;
            console.log('erroring timeout called output.end()');
            output.end();
          }
        }, 200);
      }
    }
  }
}