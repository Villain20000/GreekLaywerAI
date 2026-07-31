FROM node:20-alpine

WORKDIR /usr/src/app

# Chrome is only needed by karma (unit tests), which doesn't run in the
# container — skip the ~150 MB puppeteer browser download.
ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN npm install -g @angular/cli@17

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 4200
CMD [ "npm", "start" ]
