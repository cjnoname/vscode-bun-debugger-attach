console.log('🚀 Bun debug test script starting...');
console.log('Waiting for debugger attachment...');

function calculateSum(a: number, b: number): number {
    const result = a + b;
    console.log(`Calculating ${a} + ${b} = ${result}`);
    return result;
}

function main() {
    console.log('Starting calculation...');
    
    const num1 = 10;
    const num2 = 20;
    
    const sum = calculateSum(num1, num2);
    
    console.log(`Final result: ${num1} + ${num2} = ${sum}`);
    
    setTimeout(() => {
        console.log('Async operation completed');
        process.exit(0);
    }, 5000);
    
    console.log('Script execution completed, waiting for async operations...');
}

main();