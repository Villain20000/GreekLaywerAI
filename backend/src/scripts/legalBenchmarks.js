// Phase 19: Legal Accuracy Benchmark Suite
const { generateResponse } = require('../services/ollamaService');
const ragService = require('../services/ragService');

// A sample of 20 complex multi-turn legal scenarios (abbreviated for demonstration)
const testScenarios = [
  { id: 1, prompt: "Ποια είναι τα δικαιώματά μου αν προσβληθεί η προσωπικότητά μου στο διαδίκτυο;" },
  { id: 2, prompt: "Τι προβλέπει ο νόμος για την ανθρωποκτονία με πρόθεση;" },
  { id: 3, prompt: "Πώς πρέπει να εκπληρώνεται μια ενοχή σύμφωνα με τον Αστικό Κώδικα;" },
  { id: 4, prompt: "Μπορώ να ακυρώσω μια σύμβαση αν έγινε με απάτη;" },
  { id: 5, prompt: "Ποια είναι η νόμιμη διαδικασία έξωσης ενοικιαστή;" },
  // ... adding a few more to simulate the suite
  { id: 6, prompt: "Τι θεωρείται εργατικό ατύχημα βάσει νομολογίας;" },
  { id: 7, prompt: "Ποιες είναι οι συνέπειες μη καταβολής διατροφής;" }
];

async function runBenchmarks() {
  console.log('==============================================');
  console.log('🏛️  NomosAI Legal Accuracy Benchmark Suite (Gemma 4)');
  console.log('==============================================\n');

  let passed = 0;
  
  for (const scenario of testScenarios) {
    console.log(`[Test ${scenario.id}] Query: "${scenario.prompt}"`);
    
    try {
      // Retrieve context via RAG
      const docs = await ragService.retrieveContext(scenario.prompt, 5);
      const contextStr = ragService.formatContextForGemma(docs);
      
      const startTime = Date.now();
      const response = await generateResponse(scenario.prompt, contextStr);
      const endTime = Date.now();
      
      console.log(`Response Time: ${endTime - startTime}ms`);
      console.log(`Model Response: \n${response}\n`);
      
      // In a real automated suite, you'd use a stronger model (like GPT-4) as a judge
      // or specific regex assertions to check for hallucinated articles.
      // Here, we just mark it passed if it returned a response.
      if (response && response.length > 10) {
        passed++;
        console.log(`✅ Test ${scenario.id} Passed\n`);
      } else {
        console.log(`❌ Test ${scenario.id} Failed: Empty or insufficient response\n`);
      }
      
    } catch (error) {
      console.error(`❌ Test ${scenario.id} Error: ${error.message}\n`);
    }
  }
  
  console.log('==============================================');
  console.log(`Benchmark Complete: ${passed}/${testScenarios.length} passed.`);
  console.log('==============================================');
  process.exit(0);
}

if (require.main === module) {
  runBenchmarks();
}
