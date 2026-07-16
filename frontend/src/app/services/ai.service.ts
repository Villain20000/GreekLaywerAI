import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class AiService {
  private apiUrl = `${environment.apiBaseUrl}/api/ai`;

  constructor() { }

  streamQuery(prompt: string): Observable<string> {
    return new Observable(observer => {
      fetch(`${this.apiUrl}/query/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ prompt, useRag: true })
      })
      .then(response => {
        if (!response.body) throw new Error('ReadableStream not yet supported in this browser.');
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');

        function push() {
          reader.read().then(({ done, value }) => {
            if (done) {
              observer.complete();
              return;
            }
            const chunkStr = decoder.decode(value, { stream: true });
            const lines = chunkStr.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.substring(6).trim();
                if (data === '[DONE]') {
                  observer.complete();
                  return;
                }
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.content) {
                    observer.next(parsed.content);
                  } else if (parsed.error) {
                     observer.error(parsed.error);
                  }
                } catch (e) {
                  // ignore parse error
                }
              }
            }
            push();
          }).catch(err => {
            observer.error(err);
          });
        }
        push();
      })
      .catch(err => observer.error(err));
    });
  }

  uploadAudio(audioBlob: Blob): Observable<string> {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    
    // We reuse the streaming logic for audio parsing response
    return new Observable(observer => {
        fetch(`${this.apiUrl}/audio-query`, {
            method: 'POST',
            body: formData
        })
        .then(response => {
            if (!response.body) throw new Error('ReadableStream not yet supported in this browser.');
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');

            function push() {
              reader.read().then(({ done, value }) => {
                if (done) {
                  observer.complete();
                  return;
                }
                const chunkStr = decoder.decode(value, { stream: true });
                const lines = chunkStr.split('\n');
                for (const line of lines) {
                  if (line.startsWith('data: ')) {
                    const data = line.substring(6).trim();
                    if (data === '[DONE]') {
                      observer.complete();
                      return;
                    }
                    try {
                      const parsed = JSON.parse(data);
                      if (parsed.content) {
                        observer.next(parsed.content);
                      }
                    } catch (e) { }
                  }
                }
                push();
              }).catch(err => observer.error(err));
            }
            push();
        }).catch(err => observer.error(err));
    });
  }
}
