const AWS = require('aws-sdk');
const ec2 = new AWS.EC2();
const ssm = new AWS.SSM();

exports.handler = async (event) => {
  const params = {
    // Align with the instance type in ec2-stack.ts
    InstanceTypes: ['g5.4xlarge'],
    ProductDescriptions: ['Linux/UNIX'],
    StartTime: new Date(new Date().getTime() - (3*60*60*1000)), // 3 hours ago
    EndTime: new Date(),
  };

  try {
    const data = await ec2.describeSpotPriceHistory(params).promise();
    const spotPrices = data.SpotPriceHistory;

    // Analyze the spotPrices to determine your bidding strategy, take the average of the last 3 hours for our case
    let total = 0;
    for (const price of spotPrices) {
      total += parseFloat(price.SpotPrice);
    }
    const averagePrice = total / spotPrices.length;

    // Add 20% buffer to the averagePrice to increase the chance of fulfillment
    const maxPrice = (averagePrice * 1.2).toFixed(4);

    // Update the SSM Parameter with the new maxPrice
    const ssmParams = {
      Name: 'SpotInstanceMaxPrice', // the name of your SSM Parameter
      Value: maxPrice.toString(),
      Overwrite: true,
    };
    await ssm.putParameter(ssmParams).promise();

    console.log(`Updated maxPrice to ${maxPrice}`);
    return `Updated maxPrice to ${maxPrice}`;
  } catch (error) {
    console.error(`Error getting spot price history: ${error}`);
    throw error;
  }
};