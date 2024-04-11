# reader

## Development Guide

### Prerequisite
- Node v18 (The build fails for Node version >18)
- Yarn
- Firebase CLI (`npm install -g firebase-tools`)

### Installation

Clone the scenex repo by running the command:

```bash
git clone git@github.com:jina-ai/reader.git
git submodule init
git submodule update
```

After a successful clone, install the packages for backend and the webapp.

For backend, go to the `backend/functions` directory and install the npm dependencies.

```bash
cd backend/functions
npm install
```

For the frontend (webapp), go to the `webapp` directory and install the yarn dependencies.

```bash
cd webapp
yarn
```

### Configure

**Establish localhost connection:**

Once the packages are installed, go to the `App.vue` file inside the `webapp/src/` and uncomment the below code:

```js
connectFunctionsEmulator(functions, 'localhost', 5001);
```

### Run The Application Now

To run the backend server, inside the `backend/functions` dir run the below command:

```bash
npm run serve
```

To run the frontend app, inside the `webapp` dir run the below command:

```bash
yarn dev
```

### Known Errors

1. If you encounter 'npm ERR! /bin/sh: pkg-config: command not found' error in Mac, run the command `brew install pkg-config cairo libpng jpeg giflib pango librsvg`

## Best practices

### Directory structure

There are three folders:
1. `webapp` is the frontend project of `SceneX`, knowledge requirements:
- Vue 3
- Quasar
- ...

2. `backend` contains source code of backend logic, knowledge requirements:
- Nodejs
- Firebase
- ...

3. `scripts` folder includes custom scripts we might need during the development or for production, currently we have the following scripts:
- `translate` is responsible for translating and updating our i18n language files in frontend project.

### Best practices of frontend
1. **Quasar docs** is your `best friend`. Since the frontend project highly depends on framework `Quasar`. It is recommended to use the predefined classes and components and avoid defining your custom classes
2. **Double check** of the UI output in `Dark mode` and `Light mode`. Again, use predefined classes and props.
3. **Plugins in boot** folder: create corresponding file in `boot` folder and use them in `quasar.config.js`:
```js
module.exports = configure(function() {
  return {
    ...
    boot: [
      'i18n',
      'axios',
      'firebase',
      'addressbar-color',
      'quasar-lang-pack'
    ],
    ...
  }
})

```

### Best practices of backend
1. **Remember to deploy your functions** by running:
```bash
# deploy all functions
firebase deploy --only functions

# deploy a specific function
firebase deploy --only functions:{function name}

```
